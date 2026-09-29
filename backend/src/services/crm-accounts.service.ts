import { Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import { prisma } from '../config/database';
import { AppError } from '../middleware/error.middleware';

const accountSelect = {
  id: true, email: true, firstName: true, lastName: true, isActive: true,
  crmGrants: { select: { groupId: true, canExport: true, group: { select: { name: true } } }, orderBy: { group: { name: 'asc' as const } } },
} satisfies Prisma.UserSelect;

type Grant = { groupId: string; canExport: boolean };
function parseGrants(value: unknown): Grant[] {
  if (!Array.isArray(value) || value.length > 1000) throw new AppError('Choose valid contact groups');
  const ids = new Set<string>();
  return value.map(g => {
    if (!g || typeof g.groupId !== 'string' || !g.groupId || typeof g.canExport !== 'boolean' || ids.has(g.groupId)) throw new AppError('Choose valid, distinct contact groups');
    ids.add(g.groupId);
    return { groupId: g.groupId, canExport: g.canExport };
  });
}
async function validateGroups(tx: Prisma.TransactionClient, organizationId: string, grants: Grant[]) {
  const count = await tx.leadGroup.count({ where: { organizationId, id: { in: grants.map(g => g.groupId) } } });
  if (count !== grants.length) throw new AppError('One or more groups are unavailable', 403);
}
export function listCrmAccounts(organizationId: string) {
  return prisma.user.findMany({ where: { organizationId, role: 'CALLER' }, select: accountSelect, orderBy: { email: 'asc' } });
}
export async function createCrmAccount(organizationId: string, body: any) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new AppError('Valid email required');
  if (typeof body.firstName !== 'string' || !body.firstName.trim() || body.firstName.length > 100 || (body.lastName !== undefined && (typeof body.lastName !== 'string' || body.lastName.length > 100))) throw new AppError('Enter a name of up to 100 characters');
  if (typeof body.password !== 'string' || body.password.length < 12 || Buffer.byteLength(body.password) > 72) throw new AppError('Password must be at least 12 characters and at most 72 bytes');
  const grants = parseGrants(body.grants);
  if (!grants.length) throw new AppError('Choose at least one contact group');
  const passwordHash = await bcrypt.hash(body.password, 10);
  try {
    return await prisma.$transaction(async tx => {
      await validateGroups(tx, organizationId, grants);
      const user = await tx.user.create({
        data: { organizationId, email, firstName: body.firstName.trim(), lastName: (body.lastName || '').trim(), passwordHash, role: 'CALLER', notifyByEmail: false, crmGrants: { create: grants } },
        select: accountSelect,
      });
      // An older invitation for this email must not remain actionable.
      await tx.crmInvite.deleteMany({ where: { email, usedAt: null, group: { organizationId } } });
      return user;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new AppError('An account already uses this email. Manage its group access from Caller accounts if it belongs to your organization.', 409);
    throw error;
  }
}
export async function updateCrmAccountGroups(organizationId: string, userId: string, body: any) {
  const grants = parseGrants(body?.grants);
  return prisma.$transaction(async tx => {
    // Serialize full grant replacements so concurrent edits cannot combine into unintended access.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} AND "organizationId" = ${organizationId} AND role = 'CALLER' FOR UPDATE`;
    const user = await tx.user.findFirst({ where: { id: userId, organizationId, role: 'CALLER', isActive: true } });
    if (!user) throw new AppError('Active caller account not found', 404);
    await validateGroups(tx, organizationId, grants);
    await tx.crmGrant.deleteMany({ where: { userId } });
    if (grants.length) await tx.crmGrant.createMany({ data: grants.map(g => ({ ...g, userId })) });
    return tx.user.findUniqueOrThrow({ where: { id: userId }, select: accountSelect });
  });
}
