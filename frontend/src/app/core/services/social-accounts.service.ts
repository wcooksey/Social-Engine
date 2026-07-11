import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ApiService } from './api.service';
import {
  ConnectSocialAccountResponse,
  SocialAccount,
  SocialAccountsResponse,
  SocialPlatformParam,
  ValidateSocialAccountResponse
} from '../models/social-account.model';

/**
 * Connected social accounts (LinkedIn/Facebook/Instagram/X). Users connect once by
 * pasting a captured browser session (Playwright storageState) and the Engine's
 * browser agent reuses it for every lead instead of logging in per-lead.
 */
@Injectable({ providedIn: 'root' })
export class SocialAccountsService {
  private api = inject(ApiService);

  private readonly _accounts = signal<SocialAccount[]>([]);
  readonly accounts = this._accounts.asReadonly();

  private readonly _encryptionConfigured = signal(true);
  readonly encryptionConfigured = this._encryptionConfigured.asReadonly();

  private readonly _loaded = signal(false);
  readonly loaded = this._loaded.asReadonly();

  list(): Observable<SocialAccountsResponse> {
    return this.api.get<SocialAccountsResponse>('/api/social-accounts').pipe(
      tap(res => {
        this._accounts.set(res.accounts);
        this._encryptionConfigured.set(res.encryptionConfigured);
        this._loaded.set(true);
      })
    );
  }

  connect(platform: SocialPlatformParam, storageState: string, label?: string): Observable<ConnectSocialAccountResponse> {
    return this.api.post<ConnectSocialAccountResponse>('/api/social-accounts', { platform, label, storageState });
  }

  validate(id: string): Observable<ValidateSocialAccountResponse> {
    return this.api.post<ValidateSocialAccountResponse>(`/api/social-accounts/${id}/validate`);
  }

  disconnect(id: string): Observable<unknown> {
    return this.api.delete(`/api/social-accounts/${id}`);
  }
}
