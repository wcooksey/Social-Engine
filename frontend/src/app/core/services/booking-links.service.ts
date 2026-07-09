import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { BookingLink, BookingLinkInput } from '../models/booking-link.model';

@Injectable({ providedIn: 'root' })
export class BookingLinksService {
  private api = inject(ApiService);

  list(): Observable<BookingLink[]> {
    return this.api.get<BookingLink[]>('/api/booking-links');
  }

  create(input: BookingLinkInput): Observable<BookingLink> {
    return this.api.post<BookingLink>('/api/booking-links', input);
  }

  update(id: string, input: Partial<BookingLinkInput> & { active?: boolean }): Observable<BookingLink> {
    return this.api.patch<BookingLink>(`/api/booking-links/${id}`, input);
  }

  delete(id: string): Observable<void> {
    return this.api.delete<void>(`/api/booking-links/${id}`);
  }
}
