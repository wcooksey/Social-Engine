import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

/** Which channels are configured for this org (from GET /api/test/status). */
export interface TestChannelStatus {
  email: boolean;
  sms: boolean;
  voice: boolean;
  /** Lowercase connected platform names, e.g. ["instagram"]. */
  socialPlatforms: string[];
}

export interface TestEmailResult {
  sent: boolean;
  to: string;
  externalId: string;
}

export interface TestSmsResult {
  sent: boolean;
  to: string;
  externalId: string;
}

export interface TestCallResult {
  placed: boolean;
  to: string;
  vapiCallId: string;
}

export interface TestDmResult {
  dispatched: boolean;
  note: string;
}

/** One link in the chain a lead's reply has to survive to reach the inbox. */
export interface InboundCheck {
  key: 'secret' | 'publicUrl' | 'mailgun' | 'mx' | 'route';
  label: string;
  /** null when the check couldn't run (prerequisite failed, or Mailgun errored). */
  ok: boolean | null;
  detail: string;
}

export interface InboundEmailHealth {
  ok: boolean;
  webhookUrl: string;
  checks: InboundCheck[];
}

/**
 * Fires REAL test messages on each channel at the owner's own contact info.
 * Owner/admin only on the backend — non-admins get a 403.
 */
@Injectable({ providedIn: 'root' })
export class TestBenchService {
  private api = inject(ApiService);

  status(): Observable<TestChannelStatus> {
    return this.api.get<TestChannelStatus>('/api/test/status');
  }

  sendEmail(to: string): Observable<TestEmailResult> {
    return this.api.post<TestEmailResult>('/api/test/email', { to });
  }

  /** Checks the receiving side of email — MX records, Mailgun route, secret. */
  inboundEmailHealth(): Observable<InboundEmailHealth> {
    return this.api.get<InboundEmailHealth>('/api/test/inbound-email');
  }

  sendSms(to: string): Observable<TestSmsResult> {
    return this.api.post<TestSmsResult>('/api/test/sms', { to });
  }

  placeCall(to: string): Observable<TestCallResult> {
    return this.api.post<TestCallResult>('/api/test/call', { to });
  }

  sendDm(platform: string, profileUrl: string, message?: string): Observable<TestDmResult> {
    return this.api.post<TestDmResult>('/api/test/dm', { platform, profileUrl, message });
  }
}
