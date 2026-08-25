import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import {
  ScheduledAction,
  ScheduledActionResult,
  ScheduledPage,
  ScheduledQuery,
  ScheduledSummary,
} from '../models/scheduled.model';

/**
 * The scheduled-work feed and its brake.
 *
 * Actions come in two shapes on purpose. `applyToRefs` acts on an explicit
 * selection; `applyToScope` acts on everything matching a filter without the
 * client ever listing it, which is what makes "hold this entire campaign"
 * possible when it has four thousand due touches.
 */
@Injectable({ providedIn: 'root' })
export class ScheduledService {
  private api = inject(ApiService);

  list(query: ScheduledQuery, page = 1, pageSize = 50): Observable<ScheduledPage> {
    return this.api.get<ScheduledPage>('/api/scheduled', {
      ...this.toParams(query),
      page,
      pageSize,
    });
  }

  summary(): Observable<ScheduledSummary> {
    return this.api.get<ScheduledSummary>('/api/scheduled/summary');
  }

  applyToRefs(action: ScheduledAction, refs: string[]): Observable<ScheduledActionResult> {
    return this.api.post<ScheduledActionResult>('/api/scheduled/actions', { action, refs });
  }

  /**
   * `confirmAll` is required by the server when the scope narrows nothing — it
   * is the difference between "hold this campaign" and "hold the company".
   */
  applyToScope(
    action: ScheduledAction,
    scope: ScheduledQuery,
    confirmAll = false
  ): Observable<ScheduledActionResult> {
    return this.api.post<ScheduledActionResult>('/api/scheduled/actions', {
      action,
      scope: { ...this.toParams(scope), ...(confirmAll ? { confirmAll: true } : {}) },
    });
  }

  private toParams(query: ScheduledQuery): Record<string, unknown> {
    return {
      kind: query.kind?.length ? query.kind.join(',') : undefined,
      state: query.state?.length ? query.state.join(',') : undefined,
      campaignId: query.campaignId || undefined,
      leadId: query.leadId || undefined,
      q: query.q || undefined,
      withinHours: query.withinHours || undefined,
    };
  }
}
