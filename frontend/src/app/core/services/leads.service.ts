import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { Contact, EnrichmentStats, Lead, LeadsPage, LeadsQuery } from '../models/lead.model';

export interface LeadInput {
  companyName: string;
  website?: string;
  phone?: string;
  city?: string;
  state?: string;
  industry?: string;
  groupId?: string;
}

export interface ContactInput {
  firstName: string;
  lastName: string;
  title?: string;
  email?: string;
  phone?: string;
}

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  contactsCreated: number;
  skipped: number;
  errors: { row: number; error: string }[];
}

@Injectable({ providedIn: 'root' })
export class LeadsService {
  private api = inject(ApiService);

  list(query: LeadsQuery = {}): Observable<LeadsPage> {
    return this.api.get<LeadsPage>('/api/leads', query);
  }

  /** Tier counts, contactability and retryability for a list (org-wide or one group). */
  enrichmentStats(groupId?: string): Observable<EnrichmentStats> {
    return this.api.get<EnrichmentStats>('/api/leads/enrichment/stats', groupId ? { groupId } : {});
  }

  /** Rebuild the derived enrichment columns after a scoring change or bulk edit. */
  recomputeEnrichment(groupId?: string): Observable<{ leads: number; capabilityVersion: number }> {
    return this.api.post<{ leads: number; capabilityVersion: number }>('/api/leads/enrichment/recompute', {
      groupId
    });
  }

  get(id: string, groupId?: string): Observable<Lead> {
    return this.api.get<Lead>(`/api/leads/${id}`, { groupId });
  }

  create(input: LeadInput): Observable<Lead> {
    return this.api.post<Lead>('/api/leads', input);
  }

  update(id: string, input: Partial<LeadInput> & { status?: string }): Observable<Lead> {
    return this.api.patch<Lead>(`/api/leads/${id}`, input);
  }

  delete(id: string): Observable<void> {
    return this.api.delete<void>(`/api/leads/${id}`);
  }

  addContact(leadId: string, input: ContactInput): Observable<Contact> {
    return this.api.post<Contact>(`/api/leads/${leadId}/contacts`, input);
  }

  updateContact(contactId: string, input: Partial<ContactInput>): Observable<Contact> {
    return this.api.patch<Contact>(`/api/contacts/${contactId}`, input);
  }

  deleteContact(contactId: string): Observable<void> {
    return this.api.delete<void>(`/api/contacts/${contactId}`);
  }

  importLeads(csv: string, groupName?: string): Observable<ImportResult> {
    return this.api.post<ImportResult>('/api/leads/import', { csv, groupName });
  }
}
