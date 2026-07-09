import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ApiService } from './api.service';
import {
  OrgSetting,
  OrgSettingsResponse,
  PlatformSetting,
  PlatformSettingsResponse,
} from '../models/settings.model';

/**
 * Org integration settings (API keys, channel creds) and platform-wide
 * super-admin settings. Secret org values are never returned by the API —
 * the list only reports whether each is set and where it resolves from.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private api = inject(ApiService);

  private readonly _orgSettings = signal<OrgSetting[]>([]);
  readonly orgSettings = this._orgSettings.asReadonly();

  private readonly _platformSettings = signal<PlatformSetting[]>([]);
  readonly platformSettings = this._platformSettings.asReadonly();

  getOrgSettings(): Observable<OrgSettingsResponse> {
    return this.api.get<OrgSettingsResponse>('/api/settings/org').pipe(
      tap(res => this._orgSettings.set(res.settings))
    );
  }

  setOrgSetting(key: string, value: string): Observable<OrgSettingsResponse> {
    return this.api.put<OrgSettingsResponse>('/api/settings/org', { key, value }).pipe(
      tap(res => this._orgSettings.set(res.settings))
    );
  }

  getPlatformSettings(): Observable<PlatformSettingsResponse> {
    return this.api.get<PlatformSettingsResponse>('/api/settings/platform').pipe(
      tap(res => this._platformSettings.set(res.settings))
    );
  }

  setPlatformSetting(key: string, value: number): Observable<PlatformSettingsResponse> {
    return this.api.put<PlatformSettingsResponse>('/api/settings/platform', { key, value }).pipe(
      tap(res => this._platformSettings.set(res.settings))
    );
  }
}
