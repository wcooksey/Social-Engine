import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { CalendarEvent, CalendarEventStatus, CalendarEventType } from '../models/calendar.model';

export interface CalendarEventInput {
  title: string;
  description?: string;
  startAt: string;
  endAt?: string;
  allDay?: boolean;
  location?: string;
  type?: CalendarEventType;
  leadId?: string;
  contactId?: string;
}

export interface CalendarEventUpdate extends Partial<CalendarEventInput> {
  status?: CalendarEventStatus;
}

@Injectable({ providedIn: 'root' })
export class CalendarService {
  private api = inject(ApiService);

  listEvents(start: string, end: string): Observable<CalendarEvent[]> {
    return this.api.get<CalendarEvent[]>('/api/calendar/events', { start, end });
  }

  create(input: CalendarEventInput): Observable<CalendarEvent> {
    return this.api.post<CalendarEvent>('/api/calendar/events', input);
  }

  update(id: string, input: CalendarEventUpdate): Observable<CalendarEvent> {
    return this.api.patch<CalendarEvent>(`/api/calendar/events/${id}`, input);
  }

  delete(id: string): Observable<void> {
    return this.api.delete<void>(`/api/calendar/events/${id}`);
  }
}
