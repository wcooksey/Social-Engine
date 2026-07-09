export type CalendarEventType = 'MEETING' | 'CALL' | 'DEMO' | 'FOLLOW_UP' | 'OTHER';
export type CalendarEventStatus = 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string | null;
  startAt: string;
  endAt?: string | null;
  allDay: boolean;
  location?: string | null;
  type: CalendarEventType;
  status: CalendarEventStatus;
  lead?: { id: string; companyName: string } | null;
  contact?: { id: string; firstName: string; lastName: string } | null;
  createdByRunId?: string | null;
  createdAt: string;
}
