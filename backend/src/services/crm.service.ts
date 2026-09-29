import { Prisma } from '@prisma/client';
import { AppError } from '../middleware/error.middleware';

export const crmLeadSelect = {
  enrichmentTier: true,
  id: true, companyName: true, website: true, phone: true, address: true, city: true, state: true, postalCode: true, doNotContact: true, contactReviewReason: true,
  contacts: { select: { id: true, firstName: true, lastName: true, title: true, email: true, phone: true, optedOut: true, emailStatus: true, emailVerifiedAt: true, emailVerifiedAddress: true, source: true } },
  crmRecord: true,
} satisfies Prisma.LeadSelect;
export const STAGES = ['NEW', 'CONTACTED', 'FOLLOW_UP', 'INTERESTED', 'NOT_INTERESTED', 'WON', 'DO_NOT_CONTACT'];
export const OUTCOMES = ['NO_ANSWER', 'VOICEMAIL', 'ANSWERED', 'WRONG_NUMBER', 'INTERESTED', 'NOT_INTERESTED', 'CALLBACK', 'DO_NOT_CONTACT'];
export function crmInput(body: any) {
  if (!body || !['CALL', 'NOTE', 'UPDATE'].includes(body.kind)) throw new AppError('Invalid activity type');
  if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) throw new AppError('Request identifier required');
  if (typeof body.note !== 'string' || body.note.length > 10000 || (body.kind === 'NOTE' && !body.note.trim())) throw new AppError('Enter a note (maximum 10000 characters)');
  if (body.kind === 'CALL' && !OUTCOMES.includes(body.outcome)) throw new AppError('Choose a call outcome');
  if (body.stage !== undefined && !STAGES.includes(body.stage)) throw new AppError('Invalid pipeline stage');
  if (body.kind === 'NOTE' && (body.stage !== undefined || body.followUpAt !== undefined)) throw new AppError('Use a pipeline update to change stage or follow-up');
  if (body.kind === 'UPDATE' && body.stage === undefined && body.followUpAt === undefined) throw new AppError('Choose a stage or follow-up date to update');
  let followUpAt: Date | null | undefined;
  if (body.followUpAt !== undefined) {
    if (body.followUpAt !== null && (typeof body.followUpAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(body.followUpAt))) throw new AppError('Invalid follow-up date');
    followUpAt = body.followUpAt === null ? null : new Date(body.followUpAt);
    if (followUpAt && !Number.isFinite(followUpAt.getTime())) throw new AppError('Invalid follow-up date');
  }
  const automatic: Record<string, string> = { INTERESTED: 'INTERESTED', NOT_INTERESTED: 'NOT_INTERESTED', CALLBACK: 'FOLLOW_UP', DO_NOT_CONTACT: 'DO_NOT_CONTACT' };
  const stage = body.kind === 'CALL' ? (automatic[body.outcome] || body.stage) : body.stage;
  return { requestId: body.requestId, kind: body.kind as string, outcome: body.kind === 'CALL' ? body.outcome as string : null, note: body.note.trim(), stage, followUpAt };
}
// Quote every cell and neutralize spreadsheet formulas, including leading whitespace.
export function csvCell(value: unknown): string {
  let text = value == null ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export function crmCsv(group: string, leads: Prisma.LeadGetPayload<{ select: typeof crmLeadSelect }>[]) {
  const rows: unknown[][] = [['Group','Lead ID','Company','Website','Address','City','State','Postal code','Company phone','Contact','Title','Email','Contact phone','Email verified at','Verified address','Email status','Contact opted out','Do not contact','Stage','Calls','Last called','Follow-up','Source','Contact ID','First name','Last name']];
  for (const lead of leads) for (const c of lead.contacts.length ? lead.contacts : [null]) rows.push([group, lead.id, lead.companyName, lead.website, lead.address, lead.city, lead.state, lead.postalCode, lead.phone, c ? [c.firstName,c.lastName].filter(Boolean).join(' ') : '', c?.title,c?.email,c?.phone,c?.emailVerifiedAt,c?.emailVerifiedAddress,c?.emailStatus,c?.optedOut,lead.doNotContact,lead.crmRecord?.stage || 'NEW',lead.crmRecord?.callCount || 0,lead.crmRecord?.lastCalledAt,lead.crmRecord?.followUpAt,c?.source,c?.id,c?.firstName,c?.lastName]);
  return '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
