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
