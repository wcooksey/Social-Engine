import { Router } from 'express';
import { EnrichmentTier } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import { prisma } from '../config/database';
import { config } from '../config/environment';
import { AppError, asyncHandler } from '../middleware/error.middleware';
import { authMiddleware, roleMiddleware } from '../middleware/auth.middleware';
import { JwtPayload } from '../utils/jwt';
import { crmCsv, crmInput, crmLeadSelect } from '../services/crm.service';
import { createCrmAccount, listCrmAccounts, updateCrmAccountGroups } from '../services/crm-accounts.service';
import { importCrmCsv, previewCrmImport } from '../services/crm-import.service';

const router = Router();
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const manager = roleMiddleware('OWNER', 'ADMIN');
const isManager = (u: JwtPayload) => ['OWNER', 'ADMIN'].includes(u.role);

async function groupAccess(user: JwtPayload, groupId: string, exporting = false) {
  const group = await prisma.leadGroup.findFirst({ where: { id: groupId, organizationId: user.organizationId }, select: { id: true, name: true } });
  if (!group) throw new AppError('Group not found', 404);
  if (!isManager(user)) {
    const grant = await prisma.crmGrant.findFirst({ where: { userId: user.userId, groupId } });
    if (user.role !== 'CALLER' || !grant || (exporting && !grant.canExport)) throw new AppError('Group access not granted', 403);
  }
  return group;
}

// One-use link; acceptance is deliberately public. It cannot modify an existing account.
router.post('/accept-invite', asyncHandler(async (req, res) => {
  const { token, firstName, lastName, password } = req.body;
  if (typeof token !== 'string' || token.length !== 64 || typeof firstName !== 'string' || !firstName.trim() || firstName.length > 100 || typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72 || (lastName !== undefined && (typeof lastName !== 'string' || lastName.length > 100))) throw new AppError('Enter your name and a password of 12–72 bytes');
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.$transaction(async tx => {
    const invite = await tx.crmInvite.findUnique({ where: { tokenHash: hash(token) }, include: { group: true } });
    if (!invite || invite.usedAt || invite.expiresAt <= new Date()) throw new AppError('Invitation expired or already used', 410);
    const claimed = await tx.crmInvite.updateMany({ where: { id: invite.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (!claimed.count) throw new AppError('Invitation already used', 410);
    if (await tx.user.findUnique({ where: { email: invite.email } })) throw new AppError('Account already exists. Ask your administrator to grant access to your existing caller login.', 409);
    await tx.user.create({ data: { organizationId: invite.group.organizationId, email: invite.email, firstName: firstName.trim(), lastName: (lastName || '').trim(), passwordHash, role: 'CALLER', notifyByEmail: false, crmGrants: { create: { groupId: invite.groupId, canExport: invite.canExport } } } });
  });
  res.status(201).json({ success: true, data: { accepted: true } });
}));
router.use(authMiddleware);
router.use((req, res, next) => {
  if (!['OWNER', 'ADMIN', 'CALLER'].includes(req.user!.role)) { res.status(403).json({ success: false, error: 'CRM access not granted' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  next();
});
router.get('/accounts', manager, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await listCrmAccounts(req.user!.organizationId) });
}));
router.post('/accounts', manager, asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await createCrmAccount(req.user!.organizationId, req.body) });
}));
router.patch('/accounts/:userId/groups', manager, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await updateCrmAccountGroups(req.user!.organizationId, req.params.userId, req.body) });
}));
router.get('/groups', asyncHandler(async (req, res) => {
  const u = req.user!;
  const groups = await prisma.leadGroup.findMany({ where: { organizationId: u.organizationId, ...(!isManager(u) ? { crmGrants: { some: { userId: u.userId } } } : {}) }, select: { id: true, name: true, _count: { select: { leads: true } }, crmGrants: { where: { userId: u.userId }, select: { canExport: true } } }, orderBy: { name: 'asc' } });
  res.json({ success: true, data: groups.map(g => ({ id: g.id, name: g.name, leadCount: g._count.leads, canExport: isManager(u) || !!g.crmGrants[0]?.canExport })) });
}));
router.get('/groups/:groupId/members', manager, asyncHandler(async (req, res) => {
  await groupAccess(req.user!, req.params.groupId);
  const [members, invites] = await Promise.all([
    prisma.crmGrant.findMany({ where: { groupId: req.params.groupId }, select: { id: true, canExport: true, user: { select: { id: true, firstName: true, lastName: true, email: true } } } }),
    prisma.crmInvite.findMany({ where: { groupId: req.params.groupId, usedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, email: true, expiresAt: true, canExport: true } })
  ]);
  res.json({ success: true, data: { members, invites } });
}));
router.post('/groups/:groupId/invites', manager, asyncHandler(async (req, res) => {
  await groupAccess(req.user!, req.params.groupId);
  const email = typeof req.body.email === 'string' ? req.body.email.toLowerCase().trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new AppError('Valid email required');
  const canExport = req.body.canExport === true;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.organizationId !== req.user!.organizationId || existing.role !== 'CALLER' || !existing.isActive) throw new AppError('Cannot grant this account caller access', 409);
    await prisma.crmGrant.upsert({ where: { userId_groupId: { userId: existing.id, groupId: req.params.groupId } }, create: { userId: existing.id, groupId: req.params.groupId, canExport }, update: { canExport } });
    res.json({ success: true, data: { granted: true } }); return;
  }
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 86400000);
  await prisma.$transaction([
    prisma.crmInvite.deleteMany({ where: { groupId: req.params.groupId, email, usedAt: null } }),
    prisma.crmInvite.create({ data: { groupId: req.params.groupId, email, canExport, tokenHash: hash(token), expiresAt } })
  ]);
  // Fragment keeps the bearer invitation out of server and proxy URL logs.
  res.status(201).json({ success: true, data: { inviteUrl: `${config.appPublicUrl}/crm/accept#${token}`, expiresAt } });
}));
router.delete('/groups/:groupId/members/:id', manager, asyncHandler(async (req, res) => {
  await groupAccess(req.user!, req.params.groupId);
  await prisma.crmGrant.deleteMany({ where: { id: req.params.id, groupId: req.params.groupId } });
  res.json({ success: true, data: null });
}));
router.delete('/groups/:groupId/invites/:id', manager, asyncHandler(async (req, res) => {
  await groupAccess(req.user!, req.params.groupId);
  await prisma.crmInvite.deleteMany({ where: { id: req.params.id, groupId: req.params.groupId, usedAt: null } });
  res.json({ success: true, data: null });
}));
router.get('/groups/:groupId/export', asyncHandler(async (req, res) => {
  const group = await groupAccess(req.user!, req.params.groupId, true);
  const leads = await prisma.lead.findMany({ where: { groupId: group.id, organizationId: req.user!.organizationId }, select: crmLeadSelect, orderBy: { companyName: 'asc' } });
  res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="group-contacts.csv"');
  res.send(crmCsv(group.name, leads));
}));
router.post('/groups/:groupId/import/preview', manager, asyncHandler(async (req, res) => {
  await groupAccess(req.user!, req.params.groupId);
  const preview = previewCrmImport(req.body?.csv);
  res.json({ success: true, data: { ...preview, records: preview.records.slice(0, 5) } });
}));
router.post('/groups/:groupId/import', manager, asyncHandler(async (req, res) => {
  await groupAccess(req.user!, req.params.groupId);
  const result = await importCrmCsv(req.user!.organizationId, req.params.groupId, req.body?.csv);
  res.json({ success: true, data: result });
}));
router.get('/groups/:groupId/stats', asyncHandler(async (req, res) => {
  await groupAccess(req.user!, req.params.groupId);
  const calls = await prisma.crmEvent.groupBy({ by: ['userId', 'outcome'], where: { kind: 'CALL', lead: { groupId: req.params.groupId, organizationId: req.user!.organizationId } }, _count: { _all: true } });
  const users = await prisma.user.findMany({ where: { id: { in: calls.map(c => c.userId).filter((id): id is string => !!id) }, organizationId: req.user!.organizationId }, select: { id: true, firstName: true, lastName: true } });
  res.json({ success: true, data: users.map(u => ({ ...u, calls: calls.filter(c => c.userId === u.id).reduce((n, c) => n + c._count._all, 0), outcomes: calls.filter(c => c.userId === u.id).map(c => ({ outcome: c.outcome, count: c._count._all })) })) });
}));
router.get('/groups/:groupId/leads', asyncHandler(async (req, res) => {
  await groupAccess(req.user!, req.params.groupId);
  const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
  const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : '';
  const stage = typeof req.query.stage === 'string' ? req.query.stage : '';
  const tier = req.query.tier;
  if (tier !== undefined && tier !== '' && (typeof tier !== 'string' || !Object.values(EnrichmentTier).includes(tier as EnrichmentTier))) throw new AppError('Invalid enrichment tier');
  const where: any = { organizationId: req.user!.organizationId, groupId: req.params.groupId };
  if (tier) where.enrichmentTier = tier;
  if (search) where.OR = ['companyName', 'city', 'phone'].map(k => ({ [k]: { contains: search, mode: 'insensitive' } }));
  if (stage === 'NEW') where.AND = [{ OR: [{ crmRecord: null }, { crmRecord: { stage: 'NEW' } }] }];
  else if (stage) where.crmRecord = { stage };
  if (req.query.due === 'true') where.crmRecord = { ...where.crmRecord, followUpAt: { lte: new Date() } };
  const [leads, total] = await Promise.all([prisma.lead.findMany({ where, select: crmLeadSelect, orderBy: [{ companyName: 'asc' }, { id: 'asc' }], skip: (Math.floor(page) - 1) * 50, take: 50 }), prisma.lead.count({ where })]);
  res.json({ success: true, data: { leads, total } });
}));
router.get('/groups/:groupId/leads/:leadId', asyncHandler(async (req, res) => {
  await groupAccess(req.user!, req.params.groupId);
  const lead = await prisma.lead.findFirst({ where: { id: req.params.leadId, groupId: req.params.groupId, organizationId: req.user!.organizationId }, select: { ...crmLeadSelect, crmEvents: { orderBy: { createdAt: 'desc' }, take: 200, include: { user: { select: { firstName: true, lastName: true } } } } } });
  if (!lead) throw new AppError('Lead not found', 404);
  res.json({ success: true, data: lead });
}));
router.post('/groups/:groupId/leads/:leadId/events', asyncHandler(async (req, res) => {
  await groupAccess(req.user!, req.params.groupId);
  const input = crmInput(req.body);
  const result = await prisma.$transaction(async tx => {
    // Serialize updates per lead: duplicate retries, call counts and opt-outs
    // must remain consistent when several callers save at the same time.
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${req.params.leadId} AND "groupId" = ${req.params.groupId} AND "organizationId" = ${req.user!.organizationId} FOR UPDATE`;
    const lead = await tx.lead.findFirst({ where: { id: req.params.leadId, groupId: req.params.groupId, organizationId: req.user!.organizationId } });
    if (!lead) throw new AppError('Lead not found', 404);
    const previous = await tx.crmEvent.findUnique({ where: { userId_requestId: { userId: req.user!.userId, requestId: input.requestId } } });
    if (previous) { if (previous.leadId !== lead.id) throw new AppError('Request identifier already used', 409); return previous; }
    if (input.kind === 'CALL' && lead.doNotContact) throw new AppError('This lead is marked do not contact', 409);
    const current = await tx.crmRecord.findUnique({ where: { leadId: lead.id } });
    if (input.kind === 'CALL' && !input.stage && (!current || current.stage === 'NEW')) input.stage = 'CONTACTED';
    const author = await tx.user.findUniqueOrThrow({ where: { id: req.user!.userId } });
    const event = await tx.crmEvent.create({ data: { ...input, leadId: lead.id, userId: author.id, authorName: [author.firstName, author.lastName].filter(Boolean).join(' ') } });
    const changes = { ...(input.stage ? { stage: input.stage } : {}), ...(input.followUpAt !== undefined ? { followUpAt: input.followUpAt } : {}), ...(input.kind === 'CALL' ? { lastCalledAt: new Date() } : {}) };
    await tx.crmRecord.upsert({ where: { leadId: lead.id }, create: { leadId: lead.id, ...changes, callCount: input.kind === 'CALL' ? 1 : 0 }, update: { ...changes, ...(input.kind === 'CALL' ? { callCount: { increment: 1 } } : {}) } });
    if (input.stage === 'DO_NOT_CONTACT') await tx.lead.update({ where: { id: lead.id }, data: { doNotContact: true } });
    return event;
  });
  res.status(201).json({ success: true, data: result });
}));
export default router;
