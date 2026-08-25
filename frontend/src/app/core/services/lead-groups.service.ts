import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { LeadGroup, LeadGroupList } from '../models/lead.model';

export interface LeadGroupInput {
  name: string;
  goal: string;
}

@Injectable({ providedIn: 'root' })
export class LeadGroupsService {
  private api = inject(ApiService);

  list(): Observable<LeadGroupList> {
    return this.api.get<LeadGroupList>('/api/lead-groups');
  }

  create(input: LeadGroupInput): Observable<LeadGroup> {
    return this.api.post<LeadGroup>('/api/lead-groups', input);
  }

  update(id: string, input: Partial<LeadGroupInput>): Observable<LeadGroup> {
    return this.api.patch<LeadGroup>(`/api/lead-groups/${id}`, input);
  }

  /**
   * Delete a group. `withLeads` decides the leads' fate: false unlinks them
   * (they survive, ungrouped), true destroys them with the list. Returns how
   * many leads went and how large the orphan pool now is.
   */
  delete(id: string, withLeads = false): Observable<{ deletedLeads: number; ungroupedLeads: number }> {
    const query = withLeads ? '?withLeads=true' : '';
    return this.api.delete<{ deletedLeads: number; ungroupedLeads: number }>(
      `/api/lead-groups/${id}${query}`
    );
  }
}
