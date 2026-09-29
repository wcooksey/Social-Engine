import { prisma } from '../config/database';
import { AppError } from '../middleware/error.middleware';
import { normalizeDomain, normalizePhone } from './lead.service';
import { recomputeLeadEnrichment } from './lead-enrichment.service';
import { timezoneForState } from '../utils/timezone';

const aliases: Record<string, string> = {
  company: 'companyName', 'company name': 'companyName', companyname: 'companyName', business: 'companyName',
  'lead id': 'leadId', 'contact id': 'contactId', website: 'website', address: 'address', city: 'city', state: 'state',
  'postal code': 'postalCode', zip: 'postalCode', 'company phone': 'phone', phone: 'phone',
  contact: 'contactName', 'contact name': 'contactName', 'first name': 'firstName', 'last name': 'lastName',
  title: 'title', email: 'email', 'contact phone': 'contactPhone', 'direct phone': 'contactPhone',
  'do not contact': 'doNotContact', 'contact opted out': 'optedOut',
};

/** Strict CSV parsing: malformed quoting must never silently shift contact fields. */
function csvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  const cell = () => { row.push(field); field = ''; closed = false; };
  const line = () => { cell(); if (row.some(v => v.trim())) rows.push(row); row = []; };
  const text = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ',') cell();
    else if (c === '\r' || c === '\n') { line(); if (c === '\r' && text[i + 1] === '\n') i++; }
    else if (c === '"' && !field && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new AppError('Invalid CSV quoting. Save the file as comma-separated CSV.');
      field += c;
    }
  }
  if (quoted) throw new AppError('CSV contains an unclosed quoted field');
  if (field || row.length || closed) line();
  return rows;
}

export function previewCrmImport(csv: unknown) {
  if (typeof csv !== 'string' || !csv.trim()) throw new AppError('Choose a CSV file');
  if (Buffer.byteLength(csv) > 1_000_000) throw new AppError('CSV must be under 1 MB');
  const rows = csvRows(csv);
  if (rows.length < 2) throw new AppError('CSV must contain a header and at least one contact row');
  if (rows.length > 1001) throw new AppError('Import up to 1,000 contact rows at a time');
  const headers = rows[0].map(h => aliases[h.trim().toLowerCase()]);
  if (!headers.includes('companyName')) throw new AppError('CSV needs a Company column');
  const mapped = headers.filter(Boolean);
  if (new Set(mapped).size !== mapped.length) throw new AppError('CSV contains duplicate columns for the same field');
  const records = rows.slice(1).map((row, index) => {
    const rowNumber = index + 2;
    if (row.length !== headers.length) throw new AppError(`Row ${rowNumber}: column count does not match the header`);
    const record: Record<string, string> = {};
    headers.forEach((key, i) => {
      if (!key) return;
      // Undo only the spreadsheet formula escape used by our own exporter.
      const value = row[i].replace(/^'(?=[\s\u0000-\u001f]*[=+@-]|[\t\r\n])/, '').trim();
      if (value.length > 1000) throw new AppError(`Row ${rowNumber}: ${rows[0][i]} is too long`);
      if (value) record[key] = value;
    });
    if (!record.companyName) throw new AppError(`Row ${rowNumber}: Company is required`);
    if (record.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email)) throw new AppError(`Row ${rowNumber}: invalid email address`);
    for (const flag of ['doNotContact', 'optedOut']) {
      if (record[flag] && !/^(true|false|yes|no|1|0)$/i.test(record[flag])) throw new AppError(`Row ${rowNumber}: ${flag} must be true or false`);
    }
    return record;
  });
  return { records, total: records.length, columns: rows[0].filter((_, i) => !!headers[i]), ignoredColumns: rows[0].filter((_, i) => !headers[i]) };
}

/** Owner-only, atomic, scoped import. Never moves a lead out of another group. */
export async function importCrmCsv(organizationId: string, groupId: string, csv: unknown) {
  const { records } = previewCrmImport(csv);
  const result = await prisma.$transaction(async tx => {
    // Serializes repeat uploads to this group, including records without email.
    const groups = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "LeadGroup" WHERE id = ${groupId} AND "organizationId" = ${organizationId} FOR UPDATE`;
    if (!groups.length) throw new AppError('Group not found', 404);
    let created = 0, contactsCreated = 0;
    const touched = new Set<string>();
    for (const [index, record] of records.entries()) {
      const scope = { organizationId, groupId };
      const candidates = await tx.lead.findMany({ where: record.leadId
        ? { ...scope, id: record.leadId }
        : { ...scope, companyName: { equals: record.companyName, mode: 'insensitive' }, city: record.city || null, state: record.state || null, address: record.address || null }, take: 2 });
      if ((record.leadId && !candidates.length) || candidates.length > 1) throw new AppError(`Row ${index + 2}: lead is outside this group or ambiguous. Use a Lead ID from this group's export, or remove IDs to import a copy.`);
      let lead = candidates[0];
      const data = {
        companyName: record.companyName, website: record.website, phone: record.phone, address: record.address,
        city: record.city, state: record.state, postalCode: record.postalCode,
        ...(record.website ? { domain: normalizeDomain(record.website) } : {}),
        ...(record.phone ? { phoneNormalized: normalizePhone(record.phone) } : {}),
        ...(/^(true|yes|1)$/i.test(record.doNotContact || '') ? { doNotContact: true } : {}),
      };
      if (lead) lead = await tx.lead.update({ where: { id: lead.id }, data });
      else {
        lead = await tx.lead.create({ data: { ...scope, ...data, source: 'import', timezone: timezoneForState(record.state) } });
        created++;
      }
      touched.add(lead.id);
      const firstName = record.firstName || record.contactName?.split(/\s+/)[0];
      const lastName = record.lastName || record.contactName?.split(/\s+/).slice(1).join(' ') || null;
      if (firstName || record.email || record.contactPhone || record.contactId) {
        const email = record.email?.toLowerCase();
        const contact = await tx.contact.findFirst({ where: { leadId: lead.id, ...(record.contactId
          ? { id: record.contactId } : email ? { email } : { email: null, firstName: firstName || record.contactPhone, lastName, phone: record.contactPhone || null }) } });
        if (record.contactId && !contact) throw new AppError(`Row ${index + 2}: Contact ID does not belong to this lead`);
        const contactData = {
          ...(firstName ? { firstName } : {}), ...(lastName ? { lastName } : {}),
          title: record.title, email, phone: record.contactPhone,
          ...(/^(true|yes|1)$/i.test(record.optedOut || '') ? { optedOut: true } : {}),
          ...(contact && email && contact.email !== email ? { emailVerifiedAt: null, emailVerifiedAddress: null } : {}),
        };
        if (contact) await tx.contact.update({ where: { id: contact.id }, data: contactData });
        else {
          await tx.contact.create({ data: { organizationId, leadId: lead.id, firstName: firstName || email || record.contactPhone, lastName, ...contactData, source: 'import' } });
          contactsCreated++;
        }
      }
    }
    return { rows: records.length, created, updated: touched.size - created, contactsCreated, leadIds: [...touched] };
  }, { timeout: 60000, maxWait: 10000 });
  for (const id of result.leadIds) await recomputeLeadEnrichment(id);
  const { leadIds, ...summary } = result;
  return summary;
}
