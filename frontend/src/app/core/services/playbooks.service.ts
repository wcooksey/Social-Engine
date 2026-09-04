import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import {
  EmailTransport,
  Playbook,
  PlaybookChannel,
  PlaybookScope
} from '../models/playbook.model';

export interface PlaybookInput {
  name: string;
  scope: PlaybookScope;
  groupId?: string | null;
  campaignId?: string | null;
  leadStatus?: string | null;
  channel: PlaybookChannel;
  instructions: string;
  isActive?: boolean;
  priority?: number;
  identityName?: string | null;
  identityOrgName?: string | null;
  identityTitle?: string | null;
  identityEmail?: string | null;
  identitySignature?: string | null;
  identityPostalAddress?: string | null;
  emailTransport?: EmailTransport;
  gmailAccountId?: string | null;
}

@Injectable({ providedIn: 'root' })
export class PlaybooksService {
  private api = inject(ApiService);

  list(): Observable<Playbook[]> {
    return this.api.get<Playbook[]>('/api/playbooks');
  }

  create(input: PlaybookInput): Observable<Playbook> {
    return this.api.post<Playbook>('/api/playbooks', input);
  }

  update(id: string, input: Partial<PlaybookInput>): Observable<Playbook> {
    return this.api.patch<Playbook>(`/api/playbooks/${id}`, input);
  }

  delete(id: string): Observable<void> {
    return this.api.delete<void>(`/api/playbooks/${id}`);
  }

  /** Delete several at once — clearing out a whole line of business. */
  bulkDelete(ids: string[]): Observable<{ deleted: number; requested: number }> {
    return this.api.post<{ deleted: number; requested: number }>('/api/playbooks/bulk-delete', { ids });
  }
}
