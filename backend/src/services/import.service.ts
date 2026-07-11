import { prisma } from '../config/database';
import { leadService } from './lead.service';
import { timezoneForState } from '../utils/timezone';

/**
 * CSV lead import. Parses a raw CSV (RFC-4180-ish, quoted fields supported),
 * maps common header names to lead/contact fields, and upserts each row through
 * the same dedup path the Engine uses — so imports never create duplicates.
 */

// Minimal CSV parser handling quotes, escaped quotes, and CRLF.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // handled by the \n branch
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// Header alias → canonical field.
const FIELD_ALIASES: Record<string, string> = {
  company: 'companyName', 'company name': 'companyName', companyname: 'companyName',
  business: 'companyName', 'business name': 'companyName', organization: 'companyName',
  name: 'companyName',
  website: 'website', url: 'website', domain: 'website', site: 'website',
  phone: 'phone', 'phone number': 'phone', tel: 'phone', mobile: 'phone',
  email: 'email', 'email address': 'email', 'e-mail': 'email',
  firstname: 'firstName', 'first name': 'firstName', first: 'firstName',
  lastname: 'lastName', 'last name': 'lastName', last: 'lastName',
  'contact name': 'contactName', contact: 'contactName', 'full name': 'contactName',
  title: 'title', role: 'title', position: 'title',
  address: 'address', street: 'address',
  city: 'city', town: 'city',
  state: 'state', province: 'state', region: 'state',
  zip: 'postalCode', 'zip code': 'postalCode', postal: 'postalCode', postalcode: 'postalCode',
  industry: 'industry', sector: 'industry', vertical: 'industry',
};

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  contactsCreated: number;
  skipped: number;
  errors: { row: number; error: string }[];
}

export async function importLeadsCsv(
  organizationId: string,
  csv: string,
  opts: { groupName?: string } = {}
): Promise<ImportResult> {
  const rows = parseCsv(csv);
  const result: ImportResult = { total: 0, created: 0, updated: 0, contactsCreated: 0, skipped: 0, errors: [] };
  if (rows.length < 2) return result;

  const header = rows[0].map((h) => FIELD_ALIASES[h.trim().toLowerCase()] || h.trim().toLowerCase());

  // Ensure the target group exists once.
  let groupId: string | undefined;
  if (opts.groupName?.trim()) {
    const group = await prisma.leadGroup.upsert({
      where: { organizationId_name: { organizationId, name: opts.groupName.trim() } },
      create: { organizationId, name: opts.groupName.trim(), goal: 'Imported from CSV' },
      update: {},
    });
    groupId = group.id;
  }

  for (let r = 1; r < rows.length; r++) {
    result.total++;
    const record: Record<string, string> = {};
    header.forEach((key, i) => {
      const val = (rows[r][i] ?? '').trim();
      if (val) record[key] = val;
    });

    // Derive a company name if only a person's name was given.
    let companyName = record.companyName;
    if (!companyName && record.contactName) companyName = record.contactName;
    if (!companyName && (record.firstName || record.lastName)) {
      companyName = `${record.firstName || ''} ${record.lastName || ''}`.trim();
    }
    if (!companyName && record.email) companyName = record.email;
    if (!companyName) {
      result.skipped++;
      continue;
    }

    try {
      const { lead, created } = await leadService.upsertLead(organizationId, {
        companyName,
        website: record.website,
        phone: record.phone,
        address: record.address,
        city: record.city,
        state: record.state,
        postalCode: record.postalCode,
        industry: record.industry,
        source: 'import',
        groupId,
      });
      if (created) result.created++;
      else result.updated++;

      // Timezone from state, if we can and it's not already set.
      const tz = timezoneForState(record.state);
      if (tz && !lead.timezone) {
        await prisma.lead.update({ where: { id: lead.id }, data: { timezone: tz } });
      }

      // Attach a primary contact when we have person/contact detail.
      const first = record.firstName || (record.contactName ? record.contactName.split(/\s+/)[0] : undefined);
      const last = record.lastName || (record.contactName ? record.contactName.split(/\s+/).slice(1).join(' ') : undefined);
      if (record.email || first) {
        const email = record.email?.toLowerCase();
        const existingContact = email
          ? await prisma.contact.findFirst({ where: { leadId: lead.id, email } })
          : null;
        if (!existingContact) {
          await prisma.contact.create({
            data: {
              organizationId,
              leadId: lead.id,
              firstName: first || record.email || companyName,
              lastName: last || null,
              title: record.title || null,
              email: email || null,
              phone: record.phone || null,
              isPrimary: true,
              source: 'import',
            },
          });
          result.contactsCreated++;
        }
      }
    } catch (err) {
      result.errors.push({ row: r + 1, error: err instanceof Error ? err.message : 'Import failed' });
    }
  }
  return result;
}
