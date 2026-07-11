import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';

interface PublicSlot {
  startIso: string;
  endIso: string;
}

interface PublicBooking {
  title: string;
  description: string;
  durationMinutes: number;
  timezone: string;
  organizationName: string;
  slots: PublicSlot[];
}

interface DaySlot extends PublicSlot {
  timeLabel: string;
}

interface DayGroup {
  key: string;
  label: string;
  slots: DaySlot[];
}

@Component({
  selector: 'app-public-booking',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent, InputComponent],
  templateUrl: './public-booking.component.html',
  styleUrl: './public-booking.component.scss'
})
export class PublicBookingComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private api = inject(ApiService);

  private slug = '';

  readonly loading = signal(true);
  readonly notFound = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly booking = signal<PublicBooking | null>(null);

  readonly selectedSlot = signal<PublicSlot | null>(null);
  readonly submitting = signal(false);
  readonly submitError = signal<string | null>(null);
  readonly confirmed = signal(false);
  readonly confirmedEmail = signal('');

  // Booking form (visitor is logged out — plain fields bound with ngModel).
  name = '';
  email = '';
  phone = '';
  notes = '';

  readonly dayGroups = computed<DayGroup[]>(() => {
    const b = this.booking();
    if (!b) return [];
    const groups: DayGroup[] = [];
    const byKey = new Map<string, DayGroup>();
    for (const slot of b.slots) {
      const date = new Date(slot.startIso);
      if (isNaN(date.getTime())) continue;
      const key = date.toLocaleDateString();
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          label: date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
          slots: []
        };
        byKey.set(key, group);
        groups.push(group);
      }
      group.slots.push({
        ...slot,
        timeLabel: date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      });
    }
    return groups;
  });

  readonly hasSlots = computed(() => this.dayGroups().length > 0);

  ngOnInit(): void {
    this.slug = this.route.snapshot.paramMap.get('slug') ?? '';
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.notFound.set(false);
    this.loadError.set(null);
    this.api.get<PublicBooking>(`/api/public/booking/${this.slug}`).subscribe({
      next: (data) => {
        this.booking.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        if (err?.status === 404) {
          this.notFound.set(true);
        } else {
          this.loadError.set(err?.error?.error || err?.error?.message || 'Something went wrong loading this page.');
        }
      }
    });
  }

  selectSlot(slot: PublicSlot): void {
    this.selectedSlot.set(slot);
    this.submitError.set(null);
  }

  clearSlot(): void {
    this.selectedSlot.set(null);
    this.submitError.set(null);
  }

  selectedDayLabel(): string {
    const slot = this.selectedSlot();
    if (!slot) return '';
    const date = new Date(slot.startIso);
    return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  selectedTimeLabel(): string {
    const slot = this.selectedSlot();
    if (!slot) return '';
    const date = new Date(slot.startIso);
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  get canSubmit(): boolean {
    return !!this.name.trim() && !!this.email.trim() && !this.submitting();
  }

  submit(): void {
    const slot = this.selectedSlot();
    if (!slot) return;
    if (!this.name.trim() || !this.email.trim()) {
      this.submitError.set('Please enter your name and email.');
      return;
    }

    this.submitting.set(true);
    this.submitError.set(null);
    this.api
      .post(`/api/public/booking/${this.slug}`, {
        name: this.name.trim(),
        email: this.email.trim(),
        phone: this.phone.trim() || undefined,
        notes: this.notes.trim() || undefined,
        startIso: slot.startIso
      })
      .subscribe({
        next: () => {
          this.submitting.set(false);
          this.confirmedEmail.set(this.email.trim());
          this.confirmed.set(true);
        },
        error: (err) => {
          this.submitting.set(false);
          this.submitError.set(err?.error?.error || err?.error?.message || 'We couldn\'t book that time. Please try another slot.');
        }
      });
  }
}
