import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CampaignsService } from '../../core/services/campaigns.service';
import {
  Campaign,
  EmailSequenceStep,
  CampaignActivity,
  CampaignLeadEntry,
  CampaignLeadStatus,
  CampaignSchedule,
  CampaignStatus,
  ScheduledTouch
} from '../../core/models/campaign.model';
import { FormsModule } from '@angular/forms';
import { InputComponent } from '../../shared/components/input/input.component';
import { CardComponent } from '../../shared/components/card/card.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { DataTableComponent, DataTableCellDirective, DataTableColumn } from '../../shared/components/data-table';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-campaign-detail',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    InputComponent,
    CardComponent,
    ButtonComponent,
    BadgeComponent,
    DataTableComponent,
    DataTableCellDirective
  ],
  templateUrl: './campaign-detail.component.html',
  styleUrl: './campaign-detail.component.scss'
})
export class CampaignDetailComponent implements OnInit {
  stepForm = { subject: '', body: '', delayDays: 3, approved: false };
  stepSaving = signal(false);
  editingStepId: string | null = null;
  previewLeadId = '';
  previewResult = signal<{ subject: string | null; body: string | null; sender: string | null; blockers: string[]; nextEligibleAt: string | null } | null>(null);
  previewLoading = signal(false);
  editStep(step: EmailSequenceStep): void { this.editingStepId = step.id; this.stepForm = { subject: step.subject, body: step.body, delayDays: step.delayDays, approved: step.approved }; }
  saveStep(): void {
    this.stepSaving.set(true);
    const request = this.editingStepId ? this.campaignsService.updateStep(this.id, this.editingStepId, this.stepForm) : this.campaignsService.appendStep(this.id, this.stepForm);
    request.subscribe({ next: () => { this.stepSaving.set(false); this.editingStepId = null; this.stepForm = { subject: '', body: '', delayDays: 3, approved: false }; this.load(); this.loadSchedule(); this.toast.success('Sequence saved. Existing progress is preserved.'); }, error: err => { this.stepSaving.set(false); this.toast.error(err.error?.message || err.error?.error || 'Could not save sequence.'); } });
  }
  preview(): void {
    this.previewLoading.set(true); this.previewResult.set(null);
    this.campaignsService.preview(this.id, this.previewLeadId).subscribe({ next: result => { this.previewResult.set(result); this.previewLoading.set(false); }, error: err => { this.previewLoading.set(false); this.toast.error(err.error?.message || 'Could not preview.'); } });
  }
  campaign = signal<Campaign | null>(null);
  loading = signal(true);
  updatingStatus = signal(false);

  activities = signal<CampaignActivity[]>([]);
  activityTotal = signal(0);
  activityPage = 1;
  readonly activityPageSize = 25;
  loadingActivity = signal(true);

  leadColumns: DataTableColumn[] = [
    { key: 'companyName', header: 'Company' },
    { key: 'pipeline', header: 'Pipeline' },
    { key: 'sequence', header: 'Sequence' },
    { key: 'touches', header: 'Touches', align: 'right' },
    { key: 'lastTouchAt', header: 'Last touch' },
    { key: 'nextTouchAt', header: 'Next touch' }
  ];

  // --- schedule -----------------------------------------------------------
  schedule = signal<CampaignSchedule | null>(null);
  loadingSchedule = signal(true);
  savingTouchId = signal<string | null>(null);
  editingCycle = signal<number | null>(null);
  cycleAngle = signal('');

  /** Repeat passes that could carry an angle, whether one is written yet or not. */
  cycleSlots = computed<{ cycle: number; angle: string | null }[]>(() => {
    const s = this.schedule();
    if (!s) return [];
    const byCycle = new Map(s.cycles.map(c => [c.cycle, c.angle]));
    return Array.from({ length: Math.max(0, s.maxCycles - 1) }, (_, i) => {
      const cycle = i + 2;
      return { cycle, angle: byCycle.get(cycle) ?? null };
    });
  });

  private id = '';

  constructor(
    private campaignsService: CampaignsService,
    private route: ActivatedRoute,
    private router: Router,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id') || '';
    this.load();
    this.loadActivity();
    this.loadSchedule();
  }

  // --- schedule -----------------------------------------------------------

  loadSchedule(): void {
    this.loadingSchedule.set(true);
    this.campaignsService.schedule(this.id).subscribe({
      next: (s) => {
        this.schedule.set(s);
        this.loadingSchedule.set(false);
      },
      error: () => this.loadingSchedule.set(false)
    });
  }

  /** Date input wants yyyy-MM-dd; the API speaks ISO. */
  touchDateValue(touch: ScheduledTouch): string {
    if (!touch.nextTouchAt) return '';
    return new Date(touch.nextTouchAt).toISOString().slice(0, 10);
  }

  rescheduleTouch(touch: ScheduledTouch, value: string): void {
    // Midday, so a timezone shift can't move it to the previous day.
    const iso = value ? new Date(`${value}T12:00:00`).toISOString() : null;
    this.savingTouchId.set(touch.id);
    this.campaignsService.updateTouch(this.id, touch.id, { nextTouchAt: iso }).subscribe({
      next: () => {
        this.savingTouchId.set(null);
        this.toast.success(value ? `${touch.companyName} moved to ${value}.` : `${touch.companyName} is now due immediately.`);
        this.loadSchedule();
      },
      error: () => {
        this.savingTouchId.set(null);
        this.toast.error('Could not move that touch');
      }
    });
  }

  removeFromSequence(touch: ScheduledTouch): void {
    if (!confirm(`Stop contacting ${touch.companyName} in this campaign? Their history is kept.`)) return;
    this.savingTouchId.set(touch.id);
    this.campaignsService.updateTouch(this.id, touch.id, { status: 'REMOVED' }).subscribe({
      next: () => {
        this.savingTouchId.set(null);
        this.toast.success(`${touch.companyName} removed from the sequence.`);
        this.loadSchedule();
      },
      error: () => {
        this.savingTouchId.set(null);
        this.toast.error('Could not remove that lead');
      }
    });
  }

  dueLabel(touch: ScheduledTouch): string {
    if (!touch.nextTouchAt) return 'Due now';
    const days = Math.round((new Date(touch.nextTouchAt).getTime() - Date.now()) / 86_400_000);
    if (days <= 0) return 'Due now';
    if (days === 1) return 'Tomorrow';
    return `In ${days} days`;
  }

  // --- cycle angles --------------------------------------------------------

  startEditingCycle(cycle: number, angle: string | null): void {
    this.editingCycle.set(cycle);
    this.cycleAngle.set(angle ?? '');
  }

  saveCycleAngle(cycle: number): void {
    const angle = this.cycleAngle().trim();
    if (!angle) {
      this.toast.error('Say what is new this time round');
      return;
    }
    this.campaignsService.saveCycleAngle(this.id, cycle, angle).subscribe({
      next: () => {
        this.editingCycle.set(null);
        this.toast.success(`Pass ${cycle} will lead with that.`);
        this.loadSchedule();
      },
      error: () => this.toast.error('Could not save that angle')
    });
  }

  clearCycleAngle(cycle: number): void {
    this.campaignsService.deleteCycleAngle(this.id, cycle).subscribe({
      next: () => {
        this.editingCycle.set(null);
        this.loadSchedule();
      },
      error: () => this.toast.error('Could not clear that angle')
    });
  }

  load(): void {
    this.loading.set(true);
    this.campaignsService.get(this.id).subscribe({
      next: (campaign) => {
        this.campaign.set(campaign);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.error('Failed to load campaign');
      }
    });
  }

  loadActivity(): void {
    this.loadingActivity.set(true);
    this.campaignsService.getActivity(this.id, this.activityPage).subscribe({
      next: (res) => {
        this.activities.set(res.activities);
        this.activityTotal.set(res.total);
        this.loadingActivity.set(false);
      },
      error: () => this.loadingActivity.set(false)
    });
  }

  get activityTotalPages(): number {
    return Math.max(1, Math.ceil(this.activityTotal() / this.activityPageSize));
  }

  goToActivityPage(page: number): void {
    const clamped = Math.min(Math.max(1, page), this.activityTotalPages);
    if (clamped === this.activityPage) return;
    this.activityPage = clamped;
    this.loadActivity();
  }

  setStatus(status: CampaignStatus): void {
    this.updatingStatus.set(true);
    this.campaignsService.update(this.id, { status }).subscribe({
      next: () => {
        this.updatingStatus.set(false);
        this.toast.success(status === 'ACTIVE' ? 'Campaign activated' : `Campaign ${status.toLowerCase()}`);
        this.load();
      },
      error: () => {
        this.updatingStatus.set(false);
        this.toast.error('Failed to update campaign');
      }
    });
  }

  goToLead(entry: CampaignLeadEntry): void {
    this.router.navigate(['/leads', entry.lead.id]);
  }

  statusBadgeVariant(status: CampaignStatus): BadgeVariant {
    switch (status) {
      case 'ACTIVE': return 'success';
      case 'PAUSED': return 'warning';
      case 'COMPLETED': return 'info';
      case 'DRAFT': return 'neutral';
      default: return 'default';
    }
  }

  sequenceBadgeVariant(status: CampaignLeadStatus): BadgeVariant {
    switch (status) {
      case 'PENDING': return 'neutral';
      case 'IN_SEQUENCE': return 'info';
      case 'REPLIED': return 'warning';
      case 'INTERESTED': return 'success';
      case 'NOT_INTERESTED': return 'error';
      case 'COMPLETED': return 'purple';
      case 'REMOVED': return 'neutral';
      default: return 'default';
    }
  }

  pipelineBadgeVariant(status: string): BadgeVariant {
    switch (status) {
      case 'NEW': return 'info';
      case 'RESEARCHING': return 'purple';
      case 'CONTACTED': return 'default';
      case 'ENGAGED': return 'warning';
      case 'INTERESTED': return 'success';
      case 'NOT_INTERESTED': return 'error';
      case 'CUSTOMER': return 'success';
      case 'ARCHIVED': return 'neutral';
      default: return 'default';
    }
  }

  activityIcon(type: string): string {
    const map: Record<string, string> = {
      EMAIL_SENT: 'bi-envelope',
      EMAIL_REPLY: 'bi-envelope-open',
      EMAIL_OPENED: 'bi-envelope-open',
      EMAIL_CLICKED: 'bi-cursor',
      SMS_SENT: 'bi-chat-dots',
      SMS_REPLY: 'bi-chat-left-text',
      CALL_PLACED: 'bi-telephone',
      CALL_COMPLETED: 'bi-telephone-inbound',
      SOCIAL_TOUCH: 'bi-send',
      NOTE: 'bi-sticky',
      STATUS_CHANGE: 'bi-arrow-repeat',
      RESEARCH: 'bi-search',
      FOLLOW_UP_SCHEDULED: 'bi-clock-history'
    };
    return map[type] || 'bi-dot';
  }

  relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
