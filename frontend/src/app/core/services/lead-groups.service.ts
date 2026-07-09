import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { LeadGroup } from '../models/lead.model';

export interface LeadGroupInput {
  name: string;
  goal: string;
}

@Injectable({ providedIn: 'root' })
export class LeadGroupsService {
  private api = inject(ApiService);

  list(): Observable<LeadGroup[]> {
    return this.api.get<LeadGroup[]>('/api/lead-groups');
  }

  create(input: LeadGroupInput): Observable<LeadGroup> {
    return this.api.post<LeadGroup>('/api/lead-groups', input);
  }

  update(id: string, input: Partial<LeadGroupInput>): Observable<LeadGroup> {
    return this.api.patch<LeadGroup>(`/api/lead-groups/${id}`, input);
  }

  delete(id: string): Observable<void> {
    return this.api.delete<void>(`/api/lead-groups/${id}`);
  }
}
