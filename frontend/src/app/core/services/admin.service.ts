import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { AdminOrganization, AdminOverview, AdminUser } from '../models/admin.model';

/**
 * Super-admin operator API. Every call 403s for anyone else — the guard on the
 * route is a UX nicety, the server is the real gate.
 */
@Injectable({ providedIn: 'root' })
export class AdminService {
  private api = inject(ApiService);

  overview(): Observable<AdminOverview> {
    return this.api.get<AdminOverview>('/api/admin/overview');
  }

  organizations(): Observable<AdminOrganization[]> {
    return this.api.get<AdminOrganization[]>('/api/admin/organizations');
  }

  updateOrganization(
    id: string,
    patch: { paused?: boolean; dailySendCap?: number; socialAutonomy?: boolean }
  ): Observable<Pick<AdminOrganization, 'id' | 'paused' | 'dailySendCap' | 'socialAutonomy'>> {
    return this.api.patch(`/api/admin/organizations/${id}`, patch);
  }

  users(search?: string): Observable<AdminUser[]> {
    return this.api.get<AdminUser[]>('/api/admin/users', { search });
  }

  updateUser(
    id: string,
    patch: { isActive?: boolean; role?: string }
  ): Observable<Pick<AdminUser, 'id' | 'role' | 'isActive'>> {
    return this.api.patch(`/api/admin/users/${id}`, patch);
  }
}
