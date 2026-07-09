import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { forkJoin } from 'rxjs';
import { CalendarService, CalendarEventInput } from '../../core/services/calendar.service';
import { AgentService } from '../../core/services/agent.service';
import { LeadsService } from '../../core/services/leads.service';
import { CalendarEvent, CalendarEventStatus, CalendarEventType } from '../../core/models/calendar.model';
import { AgentJob } from '../../core/models/agent.model';
import { Lead } from '../../core/models/lead.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';
import { BadgeComponent } from '../../shared/components/badge/badge.component';
import { SwitchComponent } from '../../shared/components/switch/switch.component';
import { DialogComponent } from '../../shared/components/dialog/dialog.component';
import { ToastService } from '../../core/services/toast.service';

interface DayItem {
  kind: 'event' | 'job';
  time: number;
  event?: CalendarEvent;
  job?: AgentJob;
}

interface DayCell {
  date: Date;
  key: string;
  dayNumber: number;
  inCurrentMonth: boolean;
  isToday: boolean;
  items: DayItem[];
}

interface EventForm {
  title: string;
  type: CalendarEventType;
  date: string;
  time: string;
  allDay: boolean;
  endTime: string;
  location: string;
  description: string;
  leadId: string;
  status: CalendarEventStatus;
}

@Component({
  selector: 'app-calendar',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    CardComponent,
    ButtonComponent,
    InputComponent,
    SelectComponent,
    BadgeComponent,
    SwitchComponent,
    DialogComponent
  ],
  templateUrl: './calendar.component.html',
  styleUrl: './calendar.component.scss'
})
export class CalendarComponent implements OnInit {
  weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  maxVisiblePerDay = 3;

  viewDate = signal<Date>(this.startOfMonth(new Date()));
  days = signal<DayCell[]>([]);
  loading = signal(true);

  leads = signal<Lead[]>([]);

  showEventDialog = signal(false);
  showDayDialog = signal(false);
  showJobDialog = signal(false);

  selectedEvent = signal<CalendarEvent | null>(null);
  selectedDay = signal<DayCell | null>(null);
  selectedJob = signal<AgentJob | null>(null);

  saving = signal(false);
  deleting = signal(false);

  form: EventForm = this.emptyForm(new Date());

  typeOptions: SelectOption[] = [
    { label: 'Meeting', value: 'MEETING' },
    { label: 'Call', value: 'CALL' },
    { label: 'Demo', value: 'DEMO' },
    { label: 'Follow-up', value: 'FOLLOW_UP' },
    { label: 'Other', value: 'OTHER' }
  ];

  statusOptions: SelectOption[] = [
    { label: 'Scheduled', value: 'SCHEDULED' },
    { label: 'Completed', value: 'COMPLETED' },
    { label: 'Cancelled', value: 'CANCELLED' }
  ];

  monthLabel = computed(() =>
    this.viewDate().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  );

  leadOptions = computed<SelectOption[]>(() =>
    this.leads().map(lead => ({ label: lead.companyName, value: lead.id }))
  );

  isEditing = computed(() => this.selectedEvent() !== null);

  eventDialogTitle = computed(() => (this.isEditing() ? 'Edit Event' : 'New Event'));

  dayDialogTitle = computed(() => {
    const day = this.selectedDay();
    return day ? day.date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : '';
  });

  daysWithItems = computed(() => this.days().filter(d => d.inCurrentMonth && d.items.length > 0));

  private gridStart: Date = new Date();
  private gridEnd: Date = new Date();

  constructor(
    private calendarService: CalendarService,
    private agentService: AgentService,
    private leadsService: LeadsService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    this.loadLeads();
    this.buildDays();
    this.load();
  }

  prevMonth(): void {
    const d = this.viewDate();
    this.viewDate.set(new Date(d.getFullYear(), d.getMonth() - 1, 1));
    this.buildDays();
    this.load();
  }

  nextMonth(): void {
    const d = this.viewDate();
    this.viewDate.set(new Date(d.getFullYear(), d.getMonth() + 1, 1));
    this.buildDays();
    this.load();
  }

  goToday(): void {
    this.viewDate.set(this.startOfMonth(new Date()));
    this.buildDays();
    this.load();
  }

  private loadLeads(): void {
    this.leadsService.list({ page: 1, pageSize: 100 }).subscribe({
      next: res => this.leads.set(res.leads),
      error: () => {}
    });
  }

  private buildDays(): void {
    const view = this.viewDate();
    const year = view.getFullYear();
    const month = view.getMonth();
    const firstOfMonth = new Date(year, month, 1);
    const lastOfMonth = new Date(year, month + 1, 0);

    const gridStart = new Date(firstOfMonth);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());

    const gridEnd = new Date(lastOfMonth);
    gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));

    this.gridStart = gridStart;
    this.gridEnd = gridEnd;

    const today = this.dateKey(new Date());
    const days: DayCell[] = [];
    const cursor = new Date(gridStart);
    while (cursor <= gridEnd) {
      const dateCopy = new Date(cursor);
      const key = this.dateKey(dateCopy);
      days.push({
        date: dateCopy,
        key,
        dayNumber: dateCopy.getDate(),
        inCurrentMonth: dateCopy.getMonth() === month,
        isToday: key === today,
        items: []
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    this.days.set(days);
  }

  load(): void {
    this.loading.set(true);
    const rangeStart = new Date(this.gridStart);
    rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = new Date(this.gridEnd);
    rangeEnd.setHours(23, 59, 59, 999);

    forkJoin({
      events: this.calendarService.listEvents(rangeStart.toISOString(), rangeEnd.toISOString()),
      jobs: this.agentService.listJobs({ status: 'PENDING' })
    }).subscribe({
      next: ({ events, jobs }) => {
        this.applyData(events, jobs);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.error('Failed to load calendar');
      }
    });
  }

  private applyData(events: CalendarEvent[], jobs: AgentJob[]): void {
    const map = new Map<string, DayCell>();
    const days = this.days().map(d => ({ ...d, items: [] as DayItem[] }));
    days.forEach(d => map.set(d.key, d));

    for (const ev of events) {
      const start = new Date(ev.startAt);
      const cell = map.get(this.dateKey(start));
      if (cell) {
        cell.items.push({ kind: 'event', time: start.getTime(), event: ev });
      }
    }
    for (const job of jobs) {
      const runAt = new Date(job.runAt);
      const cell = map.get(this.dateKey(runAt));
      if (cell) {
        cell.items.push({ kind: 'job', time: runAt.getTime(), job });
      }
    }
    days.forEach(d => d.items.sort((a, b) => a.time - b.time));
    this.days.set(days);
  }

  visibleItems(day: DayCell): DayItem[] {
    return day.items.slice(0, this.maxVisiblePerDay);
  }

  overflowCount(day: DayCell): number {
    return Math.max(0, day.items.length - this.maxVisiblePerDay);
  }

  trackItem(item: DayItem): string {
    return item.kind === 'event' ? `event:${item.event?.id}` : `job:${item.job?.id}`;
  }

  eventChipClass(ev: CalendarEvent): Record<string, boolean> {
    return {
      'event-chip--meeting': ev.type === 'MEETING',
      'event-chip--call': ev.type === 'CALL',
      'event-chip--demo': ev.type === 'DEMO',
      'event-chip--followup': ev.type === 'FOLLOW_UP',
      'event-chip--other': ev.type === 'OTHER',
      'event-chip--cancelled': ev.status === 'CANCELLED',
      'event-chip--completed': ev.status === 'COMPLETED'
    };
  }

  jobLabel(job: AgentJob): string {
    const text = job.objective || job.type;
    return text.length > 42 ? `${text.slice(0, 42)}…` : text;
  }

  onDayCellClick(day: DayCell): void {
    this.openCreate(day.date);
  }

  onEventChipClick(ev: CalendarEvent, domEvent: Event): void {
    domEvent.stopPropagation();
    this.openEdit(ev);
  }

  onJobChipClick(job: AgentJob, domEvent: Event): void {
    domEvent.stopPropagation();
    this.openJobDetail(job);
  }

  onMoreClick(day: DayCell, domEvent: Event): void {
    domEvent.stopPropagation();
    this.selectedDay.set(day);
    this.showDayDialog.set(true);
  }

  openCreateToday(): void {
    this.openCreate(new Date());
  }

  openCreate(date: Date): void {
    this.selectedEvent.set(null);
    this.form = this.emptyForm(date);
    this.showEventDialog.set(true);
  }

  openEdit(ev: CalendarEvent): void {
    this.selectedEvent.set(ev);
    const start = new Date(ev.startAt);
    const end = ev.endAt ? new Date(ev.endAt) : null;
    this.form = {
      title: ev.title,
      type: ev.type,
      date: this.dateKey(start),
      time: this.timeValue(start),
      allDay: ev.allDay,
      endTime: end ? this.timeValue(end) : '',
      location: ev.location ?? '',
      description: ev.description ?? '',
      leadId: ev.lead?.id ?? '',
      status: ev.status
    };
    this.showEventDialog.set(true);
  }

  openJobDetail(job: AgentJob): void {
    this.selectedJob.set(job);
    this.showJobDialog.set(true);
  }

  closeEventDialog(): void {
    this.showEventDialog.set(false);
    this.selectedEvent.set(null);
  }

  saveEvent(): void {
    if (!this.form.title.trim() || !this.form.date) return;
    this.saving.set(true);

    const startAt = this.combineDateTime(this.form.date, this.form.allDay ? '00:00' : this.form.time || '00:00');
    let endAt: string | undefined;
    if (!this.form.allDay && this.form.endTime) {
      endAt = this.combineDateTime(this.form.date, this.form.endTime);
    }

    const payload: CalendarEventInput & { status?: CalendarEventStatus } = {
      title: this.form.title.trim(),
      description: this.form.description.trim() || undefined,
      startAt,
      endAt,
      allDay: this.form.allDay,
      location: this.form.location.trim() || undefined,
      type: this.form.type,
      leadId: this.form.leadId || undefined
    };

    const editing = this.selectedEvent();
    const request = editing
      ? this.calendarService.update(editing.id, { ...payload, status: this.form.status })
      : this.calendarService.create(payload);

    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.closeEventDialog();
        this.toast.success(editing ? 'Event updated' : 'Event created');
        this.load();
      },
      error: () => {
        this.saving.set(false);
        this.toast.error(editing ? 'Failed to update event' : 'Failed to create event');
      }
    });
  }

  deleteEvent(): void {
    const editing = this.selectedEvent();
    if (!editing) return;
    this.deleting.set(true);
    this.calendarService.delete(editing.id).subscribe({
      next: () => {
        this.deleting.set(false);
        this.closeEventDialog();
        this.toast.success('Event deleted');
        this.load();
      },
      error: () => {
        this.deleting.set(false);
        this.toast.error('Failed to delete event');
      }
    });
  }

  private emptyForm(date: Date): EventForm {
    return {
      title: '',
      type: 'MEETING',
      date: this.dateKey(date),
      time: '09:00',
      allDay: false,
      endTime: '10:00',
      location: '',
      description: '',
      leadId: '',
      status: 'SCHEDULED'
    };
  }

  private combineDateTime(dateStr: string, timeStr: string): string {
    return new Date(`${dateStr}T${timeStr}:00`).toISOString();
  }

  private startOfMonth(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  private dateKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private timeValue(d: Date): string {
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }
}
