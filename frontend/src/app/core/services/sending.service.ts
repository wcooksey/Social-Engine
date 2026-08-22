import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ApiService } from './api.service';
import { DomainPurpose, SendingDomain, SendingOverview, SenderPool } from '../models/sending.model';

/**
 * Sending infrastructure: the domains cold email leaves from, the addresses on
 * them, and the pools that tie those addresses to playbooks. Reads refresh a
 * shared signal so the page can re-render after any mutation without threading
 * state through every caller.
 */
@Injectable({ providedIn: 'root' })
export class SendingService {
  private api = inject(ApiService);

  private readonly _overview = signal<SendingOverview | null>(null);
  readonly overview = this._overview.asReadonly();

  private readonly _pools = signal<SenderPool[]>([]);
  readonly pools = this._pools.asReadonly();

  load(): Observable<SendingOverview> {
    return this.api
      .get<SendingOverview>('/api/sending')
      .pipe(tap(res => this._overview.set(res)));
  }

  loadPools(): Observable<{ pools: SenderPool[] }> {
    return this.api
      .get<{ pools: SenderPool[] }>('/api/sending/pools')
      .pipe(tap(res => this._pools.set(res.pools)));
  }

  adoptLegacy(): Observable<{ domain: SendingDomain }> {
    return this.api.post<{ domain: SendingDomain }>('/api/sending/adopt');
  }

  addDomain(domain: string, purpose: DomainPurpose, apiKey?: string): Observable<unknown> {
    return this.api.post('/api/sending/domains', { domain, purpose, apiKey });
  }

  verifyDomain(id: string): Observable<unknown> {
    return this.api.post(`/api/sending/domains/${id}/verify`);
  }

  updateDomain(id: string, body: Record<string, unknown>): Observable<unknown> {
    return this.api.patch(`/api/sending/domains/${id}`, body);
  }

  deleteDomain(id: string): Observable<unknown> {
    return this.api.delete(`/api/sending/domains/${id}`);
  }

  addMailbox(domainId: string, body: Record<string, unknown>): Observable<unknown> {
    return this.api.post(`/api/sending/domains/${domainId}/mailboxes`, body);
  }

  updateMailbox(id: string, body: Record<string, unknown>): Observable<unknown> {
    return this.api.patch(`/api/sending/mailboxes/${id}`, body);
  }

  deleteMailbox(id: string): Observable<unknown> {
    return this.api.delete(`/api/sending/mailboxes/${id}`);
  }

  createPool(name: string, mailboxIds: string[]): Observable<unknown> {
    return this.api.post('/api/sending/pools', { name, mailboxIds });
  }

  updatePool(id: string, body: Record<string, unknown>): Observable<unknown> {
    return this.api.patch(`/api/sending/pools/${id}`, body);
  }

  deletePool(id: string): Observable<unknown> {
    return this.api.delete(`/api/sending/pools/${id}`);
  }
}
