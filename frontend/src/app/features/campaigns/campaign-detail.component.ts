import { OrganizationService, OrganizationSettings } from '../../core/services/organization.service';
import { SelectComponent } from '../../shared/components/select/select.component';
import { CampaignInput } from '../../core/services/campaigns.service';
import { inject } from '@angular/core';
import { GroupContextService } from '../../core/services/group-context.service';
import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CampaignsService, SupersededDraftReport } from '../../core/services/campaigns.service';
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
    SelectComponent,
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
  context = inject(GroupContextService);
  readonly workspaceGroupId = this.context.currentId();

  private organizationService = inject(OrganizationService);
  organization = signal<OrganizationSettings | null>(null);
  editingSettings = signal(false);
  savingSettings = signal(false);
  settingsForm: CampaignInput = { name: '', offer: '', channels: ['EMAIL'], mode: 'APPROVAL_REQUIRED', followUpCadenceDays: 3, maxTouches: 3, reEngageAfterDays: null, maxCycles: 1 };
  modeOptions = [{ label: 'Human approval required', value: 'APPROVAL_REQUIRED' }, { label: 'Autonomous', value: 'AUTONOMOUS' }];
  quietHoursLabel(): string {
    const org = this.organization();
    if (!org) return 'Open organization settings to view quiet hours.';
    if (org.quietHoursStart === org.quietHoursEnd) return 'No quiet hours configured.';
    return `${String(org.quietHoursStart).padStart(2, '0')}:00–${String(org.quietHoursEnd).padStart(2, '0')}:00 in each lead’s local time.`;
  }
  get returnTo(): string { return this.router.url.split('?')[0]; }
  editSettings(): void {
    const c = this.campaign();
    if (!c) return;
    this.settingsForm = { name: c.name, offer: c.offer || '', channels: [...c.channels], mode: c.mode, followUpCadenceDays: c.followUpCadenceDays, maxTouches: c.maxTouches, reEngageAfterDays: c.reEngageAfterDays ?? null, maxCycles: c.maxCycles ?? 1 };
    this.editingSettings.set(true);
  }
  saveSettings(): void {
    const c = this.campaign();
    if (!c || !this.settingsForm.name.trim()) return;
    const data: Partial<CampaignInput> = { ...this.settingsForm, name: this.settingsForm.name.trim(), reEngageAfterDays: this.settingsForm.reEngageAfterDays || null };
    if (c.sequenceEnabled) { delete data.channels; delete data.followUpCadenceDays; delete data.maxTouches; delete data.reEngageAfterDays; delete data.maxCycles; }
    this.savingSettings.set(true);
    this.campaignsService.update(this.id, data).subscribe({
      next: () => { this.savingSettings.set(false); this.editingSettings.set(false); this.load(); this.loadSchedule(); this.toast.success('Campaign settings saved for all enrolled groups.'); },
      error: err => { this.savingSettings.set(false); this.toast.error(err.error?.message || err.error?.error || 'Could not save campaign settings.'); }
    });
  }

  sendingSummary = signal<any>(null);
  refreshSendingSummary(): void { this.campaignsService.sendingSummary(this.id).subscribe({ next: s => this.sendingSummary.set(s), error: () => this.sendingSummary.set(null) }); }
  continuationPlan = signal<any>(null);
  continuationSteps = [
    { subject: 'Quick question for {{companyName}}', body: 'Hey {{companyName}},\n\nQuick question... I created a new software for dealerships to increase sales. Do you mind if I send a quick video over showing how it works?', delayDays: 1, approved: true },
    { subject: 'Re: Quick question for {{companyName}}', body: 'Hey {{companyName}},\n\nJust following up on my note. Would you like me to send over the short video showing how our dealership software works?', delayDays: 2, approved: true },
    { subject: 'Re: Quick question for {{companyName}}', body: 'Hey {{companyName}},\n\nOne last follow-up — would a quick look at our dealership software be useful? Happy to send the short video if so.', delayDays: 3, approved: true }
  ];
  inspectContinuation(): void {
    this.campaignsService.continuation(this.id).subscribe({ next: p => this.continuationPlan.set(p), error: e => this.toast.error(e.error?.message || 'Could not inspect continuation.') });
  }
  applyContinuation(): void {
    const plan = this.continuationPlan(); if (!plan) return;
    this.stepSaving.set(true);
    this.campaignsService.continueSequence(this.id, { eligibleIds: plan.eligible.map((r: any) => r.id), steps: this.continuationSteps }).subscribe({ next: () => { this.stepSaving.set(false); this.continuationPlan.set(null); this.load(); this.loadSchedule(); this.toast.success('Sequence saved. Campaign remains paused until resumed.'); }, error: e => { this.stepSaving.set(false); this.toast.error(e.error?.message || 'Could not continue sequence.'); } });
  }

  draftReport = signal<SupersededDraftReport | null>(null);
  checkingDrafts = signal(false);
  cancellingDrafts = signal(false);
  checkSupersededDrafts(): void {
    this.checkingDrafts.set(true);
    this.draftReport.set(null);
    this.campaignsService.supersededDrafts(this.id).subscribe({
      next: report => { this.draftReport.set(report); this.checkingDrafts.set(false); },
      error: err => { this.checkingDrafts.set(false); this.toast.error(err.error?.message || 'Could not check drafts.'); }
    });
  }
  cancelSupersededDrafts(): void {
    const report = this.draftReport();
    if (!report?.matches.length || this.cancellingDrafts()) return;
    this.cancellingDrafts.set(true);
    this.campaignsService.cancelSupersededDrafts(this.id, report.matches.map(({ draftId, sentMessageId }) => ({ draftId, sentMessageId }))).subscribe({
      next: result => { this.cancellingDrafts.set(false); this.toast.success(`${result.cancelled} duplicate drafts cancelled; ${result.skipped} skipped. Nothing sent.`); this.checkSupersededDrafts(); this.loadActivity(); this.refreshSendingSummary(); },
      error: err => { this.cancellingDrafts.set(false); this.toast.error(err.error?.message || 'Could not reconcile drafts. Recheck before retrying.'); }
    });
  }
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

  leadPage = 1;
  readonly leadPageSize = 25;
  upcomingPage = 1;
  readonly upcomingPageSize = 10;

  loadingLeads = signal(false);

  get upcomingTotalPages(): number {
    return Math.max(1, Math.ceil((this.schedule()?.upcomingTotal || 0) / this.upcomingPageSize));
  }

  goToLeadPage(page: number): void {
    if (this.loadingLeads()) return;
    const previousPage = this.leadPage;
    this.leadPage = page;
    this.loadingLeads.set(true);
    this.campaignsService.get(this.id, this.workspaceGroupId || undefined, page, this.leadPageSize).subscribe({
      next: campaign => {
        this.campaign.set(campaign);
        this.leadPage = campaign.leadPage;
        this.loadingLeads.set(false);
      },
      error: () => {
        this.loadingLeads.set(false);
        this.leadPage = previousPage;
        this.toast.error('Could not load enrolled leads');
      }
    });
  }

  goToUpcomingPage(page: number): void {
    if (this.loadingSchedule()) return;
    this.loadSchedule(Math.min(Math.max(1, page), this.upcomingTotalPages));
  }

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
    this.organizationService.getMine().subscribe({ next: org => this.organization.set(org), error: () => this.organization.set(null) });
    this.loadActivity();
    this.loadSchedule();
  }

  // --- schedule -----------------------------------------------------------

  loadSchedule(page = this.upcomingPage): void {
    this.loadingSchedule.set(true);
    this.campaignsService.schedule(this.id, 14, page, this.upcomingPageSize).subscribe({
      next: (s) => {
        this.schedule.set(s);
        this.upcomingPage = s.page;
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
    this.refreshSendingSummary();
    this.loading.set(true);
    this.campaignsService.get(this.id, this.workspaceGroupId || undefined, this.leadPage, this.leadPageSize).subscribe({
      next: (campaign) => {
        this.campaign.set(campaign);
        this.leadPage = campaign.leadPage;
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
    this.router.navigate(this.context.link('leads', entry.lead.id));
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
