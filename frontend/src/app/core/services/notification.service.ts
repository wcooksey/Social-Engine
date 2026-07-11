import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ApiService } from './api.service';
import {
  AppNotification,
  MarkReadResponse,
  NotificationsResponse,
} from '../models/notification.model';

/**
 * In-app notifications for the authenticated shell. Exposes reactive `unread`
 * and `items` signals for the header bell, and polls the API on an interval
 * while the shell is mounted.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private api = inject(ApiService);

  private readonly _unread = signal(0);
  readonly unread = this._unread.asReadonly();

  private readonly _items = signal<AppNotification[]>([]);
  readonly items = this._items.asReadonly();

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private static readonly POLL_INTERVAL_MS = 60_000;

  /** Fetch the latest notifications and unread count. */
  refresh(): Observable<NotificationsResponse> {
    return this.api.get<NotificationsResponse>('/api/notifications').pipe(
      tap(res => {
        this._items.set(res.notifications);
        this._unread.set(res.unread);
      })
    );
  }

  /** Mark every notification read; sync the unread count and local items. */
  markAllRead(): Observable<MarkReadResponse> {
    return this.api.post<MarkReadResponse>('/api/notifications/read', {}).pipe(
      tap(res => {
        this._unread.set(res.unread);
        this._items.update(list => list.map(n => ({ ...n, read: true })));
      })
    );
  }

  /** Begin polling `refresh()` on an interval; refreshes once immediately. */
  startPolling(): void {
    this.refresh().subscribe({ error: () => {} });
    if (this.pollHandle !== null) return;
    this.pollHandle = setInterval(() => {
      this.refresh().subscribe({ error: () => {} });
    }, NotificationService.POLL_INTERVAL_MS);
  }

  /** Stop the polling interval. */
  stopPolling(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }
}
