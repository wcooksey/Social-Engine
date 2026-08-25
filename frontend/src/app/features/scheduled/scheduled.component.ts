import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { ScheduledService } from '../../core/services/scheduled.service';
import { CampaignsService } from '../../core/services/campaigns.service';
import { ToastService } from '../../core/services/toast.service';
import {
  KIND_META,
  STATE_META,
  ScheduledAction,
  ScheduledActionResult,
  ScheduledItem,
  ScheduledKind,
  ScheduledQuery,
  ScheduledState,
  ScheduledSummary,
} from '../../core/models/scheduled.model';
import { Campaign } from '../../core/models/campaign.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { DialogComponent } from '../../shared/components/dialog/dialog.component';
import {
  DataTableCellDirective,
  DataTableColumn,
  DataTableComponent,
} from '../../shared/components/data-table';
import { apiErrorMessage } from '../../core/utils/api-error';

/**
 * Scheduled: everything the platform will do on its own, and the brake.
 *
 * The page exists because five separate mechanisms can send without a human,
 * and two of them (campaign cadence, Autopilot goals) do not hold a message —
 * they WRITE new ones every few minutes. Stopping the output of a generator
 * without stopping the generator is what makes cancelled outreach keep
 * arriving, so the layout leads with which generators are running before it
 * shows a single row.
 */
@Component({
  selector: 'app-scheduled',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    CardComponent,
    BadgeComponent,
    ButtonComponent,
    DialogComponent,
    DataTableComponent,
    DataTableCellDirective,
  ],
  templateUrl: './scheduled.component.html',
  styleUrl: './scheduled.component.scss',
})
export class ScheduledComponent implements OnInit, OnDestroy {
  readonly kindMeta = KIND_META;
  readonly stateMeta = STATE_META;
  readonly allKinds: ScheduledKind[] = ['MESSAGE', 'JOB', 'CADENCE', 'GOAL', 'REMINDER'];
  readonly allStates: ScheduledState[] = ['DUE', 'SCHEDULED', 'PAUSED', 'RUNNING', 'NEEDS_APPROVAL'];

  summary = signal<ScheduledSummary | null>(null);
  items = signal<ScheduledItem[]>([]);
  total = signal(0);
  truncatedKinds = signal<ScheduledKind[]>([]);
  campaigns = signal<Campaign[]>([]);

  loading = signal(true);
  loadingSummary = signal(true);
  busy = signal<string | null>(null);

  page = signal(1);
  readonly pageSize = 50;

  // Filters
  kindFilter = signal<Set<ScheduledKind>>(new Set());
  stateFilter = signal<Set<ScheduledState>>(new Set());
  campaignFilter = signal('');
  horizonFilter = signal<number | null>(null);
  search = signal('');

  selectedIds = signal<Set<string>>(new Set());

  expanded = signal<Set<string>>(new Set());

  // Confirmation for anything that cannot be undone or reaches beyond the page.
  confirm = signal<{
    action: ScheduledAction;
    mode: 'selection' | 'scope';
    count: number;
    title: string;
    body: string;
    confirmAll: boolean;
  } | null>(null);

  lastResult = signal<ScheduledActionResult | null>(null);

  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  columns: DataTableColumn[] = [
    { key: 'dueAt', header: 'Fires', width: '160px' },
    { key: 'kind', header: 'What', width: '150px' },
    { key: 'title', header: 'Detail' },
    { key: 'state', header: 'Status', width: '120px' },
    { key: 'actions', header: '', align: 'right', width: '150px' },
  ];

  constructor(
    private scheduled: ScheduledService,
    private campaignsService: CampaignsService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    this.load();
    this.loadSummary();
    this.campaignsService.list().subscribe({
      next: (list) => this.campaigns.set(list),
      error: () => this.campaigns.set([]),
    });
    // The feed moves on its own — the sweeps run every few minutes — so a stale
    // page here would be the same blindness the page exists to fix.
    this.refreshTimer = setInterval(() => {
      if (!this.busy() && !this.confirm()) {
        this.load(true);
        this.loadSummary(true);
      }
    }, 30_000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  // ---- Loading ----

  query(): ScheduledQuery {
    return {
      kind: [...this.kindFilter()],
      state: [...this.stateFilter()],
      campaignId: this.campaignFilter() || undefined,
      q: this.search().trim() || undefined,
      withinHours: this.horizonFilter() ?? undefined,
    };
  }

  load(quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.scheduled.list(this.query(), this.page(), this.pageSize).subscribe({
      next: (res) => {
        this.items.set(res.items);
        this.total.set(res.total);
        this.truncatedKinds.set(res.truncatedKinds);
        this.loading.set(false);
        // Drop selections for rows that have since fired or been acted on, so a
        // later bulk action can never hit something the operator can't see.
        const visible = new Set(res.items.map((i) => i.ref));
        const kept = new Set([...this.selectedIds()].filter((ref) => visible.has(ref)));
        if (kept.size !== this.selectedIds().size) this.selectedIds.set(kept);
      },
      error: (err) => {
        this.loading.set(false);
        this.toast.error(apiErrorMessage(err, 'Could not load scheduled work'));
      },
    });
  }

  loadSummary(quiet = false): void {
    if (!quiet) this.loadingSummary.set(true);
    this.scheduled.summary().subscribe({
      next: (res) => {
        this.summary.set(res);
        this.loadingSummary.set(false);
      },
      error: () => this.loadingSummary.set(false),
    });
  }

  // ---- Filters ----

  toggleKind(kind: ScheduledKind): void {
    const next = new Set(this.kindFilter());
    next.has(kind) ? next.delete(kind) : next.add(kind);
    this.kindFilter.set(next);
    this.resetAndLoad();
  }

  toggleState(state: ScheduledState): void {
    const next = new Set(this.stateFilter());
    next.has(state) ? next.delete(state) : next.add(state);
    this.stateFilter.set(next);
    this.resetAndLoad();
  }

  setHorizon(hours: number | null): void {
    this.horizonFilter.set(this.horizonFilter() === hours ? null : hours);
    this.resetAndLoad();
  }

  onCampaignFilter(value: string): void {
    this.campaignFilter.set(value);
    this.resetAndLoad();
  }

  onSearch(value: string): void {
    this.search.set(value);
    this.resetAndLoad();
  }

  clearFilters(): void {
    this.kindFilter.set(new Set());
    this.stateFilter.set(new Set());
    this.campaignFilter.set('');
    this.horizonFilter.set(null);
    this.search.set('');
    this.resetAndLoad();
  }

  hasFilters = computed(
    () =>
      this.kindFilter().size > 0 ||
      this.stateFilter().size > 0 ||
      !!this.campaignFilter() ||
      this.horizonFilter() !== null ||
      !!this.search().trim()
  );

  private resetAndLoad(): void {
    this.page.set(1);
    this.selectedIds.set(new Set());
    this.load();
  }

  onPageChange(page: number): void {
    this.page.set(page);
    this.load();
  }

  // ---- Selection ----

  onSelectionChange(ids: Set<string>): void {
    this.selectedIds.set(new Set(ids));
  }

  selectedItems = computed(() => {
    const ids = this.selectedIds();
    return this.items().filter((i) => ids.has(i.ref));
  });

  /** How many of the current selection can actually take this action. */
  eligible(action: ScheduledAction): ScheduledItem[] {
    return this.selectedItems().filter((i) => i.actions[action]);
  }

  /** True when the selection includes output from a generator that stays live. */
  selectionLeavesGeneratorRunning = computed(() => {
    const selected = this.selectedItems();
    if (selected.length === 0) return false;
    const hasGenerated = selected.some(
      (i) => (i.kind === 'MESSAGE' && i.campaign) || (i.kind === 'JOB' && i.meta['fromCadence'] === true)
    );
    const stoppingGenerator = selected.some((i) => i.kind === 'CADENCE' || i.kind === 'GOAL');
    return hasGenerated && !stoppingGenerator;
  });

  // ---- Row expansion ----

  toggleExpanded(ref: string): void {
    const next = new Set(this.expanded());
    next.has(ref) ? next.delete(ref) : next.add(ref);
    this.expanded.set(next);
  }

  isExpanded(ref: string): boolean {
    return this.expanded().has(ref);
  }

  // ---- Actions ----

  /** One row, straight through — a single click on an explicit thing. */
  rowAction(item: ScheduledItem, action: ScheduledAction): void {
    if (action === 'cancel') {
      this.confirm.set({
        action,
        mode: 'selection',
        count: 1,
        title: `Cancel this ${this.kindMeta[item.kind].label.toLowerCase()}?`,
        body: this.cancelWarning([item]),
        confirmAll: false,
      });
      this.pendingRefs = [item.ref];
      return;
    }
    this.run(action, [item.ref], `${item.ref}:${action}`);
  }

  private pendingRefs: string[] = [];

  bulk(action: ScheduledAction): void {
    const targets = this.eligible(action);
    if (targets.length === 0) {
      this.toast.info(`Nothing in the selection can be ${action}d.`);
      return;
    }
    const refs = targets.map((t) => t.ref);

    if (action === 'resume') {
      this.run(action, refs, `bulk:${action}`);
      return;
    }

    this.pendingRefs = refs;
    this.confirm.set({
      action,
      mode: 'selection',
      count: targets.length,
      title:
        action === 'pause'
          ? `Hold ${targets.length} scheduled item${targets.length === 1 ? '' : 's'}?`
          : `Cancel ${targets.length} scheduled item${targets.length === 1 ? '' : 's'}?`,
      body: action === 'pause' ? this.pauseWarning(targets) : this.cancelWarning(targets),
      confirmAll: false,
    });
  }

  /**
   * Act on everything the current filter matches, not just this page. The whole
   * reason bulk controls exist: a runaway campaign has thousands of due rows.
   */
  bulkScope(action: ScheduledAction): void {
    const scoped = this.hasFilters();
    this.pendingRefs = [];
    this.confirm.set({
      action,
      mode: 'scope',
      count: this.total(),
      title: scoped
        ? `${this.actionVerb(action)} everything matching these filters?`
        : `${this.actionVerb(action)} ALL scheduled work for this organization?`,
      body: scoped
        ? `This reaches every row the current filters match — about ${this.total()} on this page's ` +
          'query, and any beyond it. It is not limited to what you can see.'
        : 'Nothing is narrowing this. It reaches every queued message, every scheduled agent job, ' +
          'every campaign touch, every Autopilot goal and every meeting reminder in the organization — ' +
          'including work you have not looked at.',
      confirmAll: !scoped,
    });
  }

  confirmAction(): void {
    const pending = this.confirm();
    if (!pending) return;

    if (pending.mode === 'scope') {
      this.busy.set('scope');
      this.scheduled.applyToScope(pending.action, this.query(), pending.confirmAll).subscribe({
        next: (res) => this.afterAction(res),
        error: (err) => this.afterError(err),
      });
      return;
    }
    this.run(pending.action, this.pendingRefs, 'confirm');
  }

  private run(action: ScheduledAction, refs: string[], busyKey: string): void {
    if (refs.length === 0) return;
    this.busy.set(busyKey);
    this.scheduled.applyToRefs(action, refs).subscribe({
      next: (res) => this.afterAction(res),
      error: (err) => this.afterError(err),
    });
  }

  private afterAction(res: ScheduledActionResult): void {
    this.busy.set(null);
    this.confirm.set(null);
    this.pendingRefs = [];
    this.selectedIds.set(new Set());
    this.lastResult.set(res.notes.length || res.skipped.length ? res : null);

    if (res.applied === 0) {
      this.toast.warning(
        `Nothing changed — those rows had already fired or were already ${res.action}d.`
      );
    } else {
      const detail = Object.entries(res.byKind)
        .map(([kind, n]) => `${n} ${this.kindMeta[kind as ScheduledKind].short.toLowerCase()}`)
        .join(', ');
      this.toast.success(`${this.actionVerb(res.action)}: ${detail}.`);
    }
    this.load(true);
    this.loadSummary(true);
  }

  private afterError(err: unknown): void {
    this.busy.set(null);
    this.toast.error(apiErrorMessage(err, 'That action could not be completed'));
  }

  cancelConfirm(): void {
    this.confirm.set(null);
    this.pendingRefs = [];
  }

  dismissResult(): void {
    this.lastResult.set(null);
  }

  // ---- Generator shortcuts: the thing that actually stops sending ----

  holdCampaign(campaignId: string): void {
    this.busy.set(`campaign:${campaignId}`);
    this.scheduled
      .applyToScope('pause', { campaignId, kind: ['CADENCE', 'JOB', 'MESSAGE'] })
      .subscribe({
        next: (res) => this.afterAction(res),
        error: (err) => this.afterError(err),
      });
  }

  resumeCampaign(campaignId: string): void {
    this.busy.set(`campaign:${campaignId}`);
    this.scheduled
      .applyToScope('resume', {
        campaignId,
        kind: ['CADENCE', 'JOB', 'MESSAGE'],
        state: ['PAUSED'],
      })
      .subscribe({
        next: (res) => this.afterAction(res),
        error: (err) => this.afterError(err),
      });
  }

  filterToCampaign(campaignId: string): void {
    this.campaignFilter.set(campaignId);
    this.resetAndLoad();
  }

  // ---- Copy ----

  private actionVerb(action: ScheduledAction): string {
    return action === 'pause' ? 'Held' : action === 'resume' ? 'Resumed' : 'Cancelled';
  }

  private pauseWarning(items: ScheduledItem[]): string {
    const generated = items.filter(
      (i) => (i.kind === 'MESSAGE' && i.campaign) || (i.kind === 'JOB' && i.meta['fromCadence'] === true)
    ).length;
    const holdsGenerator = items.some((i) => i.kind === 'CADENCE' || i.kind === 'GOAL');

    const base =
      'Holding is reversible — the composed message, the objective and the touch count are all kept, ' +
      'and resuming puts them back exactly as they were.';

    if (generated > 0 && !holdsGenerator) {
      return (
        `${base}\n\nBut ${generated} of these were CREATED by a campaign or an Autopilot goal that is ` +
        'still running. Holding them stops this copy only — the next sweep, within minutes, composes ' +
        'replacements. To actually stop the outreach, hold the campaign touch rows or the goal too.'
      );
    }
    return base;
  }

  private cancelWarning(items: ScheduledItem[]): string {
    const cadence = items.filter((i) => i.kind === 'CADENCE').length;
    const goals = items.filter((i) => i.kind === 'GOAL').length;
    const parts = [
      'Cancelling cannot be undone. Hold instead if you only want this to stop for now.',
    ];
    if (cadence > 0) {
      parts.push(
        `${cadence} campaign touch row(s) will be REMOVED from their sequence permanently — those leads ` +
          'get no further touches from that campaign unless you re-enroll them.'
      );
    }
    if (goals > 0) {
      parts.push(`${goals} Autopilot goal(s) will be cancelled and will stop re-queueing work.`);
    }
    const generated = items.filter(
      (i) => (i.kind === 'MESSAGE' && i.campaign) || (i.kind === 'JOB' && i.meta['fromCadence'] === true)
    ).length;
    if (generated > 0 && cadence === 0) {
      parts.push(
        `${generated} of these came from a campaign that is still running — cancelling them does not ` +
          'stop it composing more.'
      );
    }
    return parts.join('\n\n');
  }

  // ---- Display helpers ----

  badgeVariant(state: ScheduledState): BadgeVariant {
    return this.stateMeta[state].variant as BadgeVariant;
  }

  /**
   * Table cell templates hand rows back as `any`, so meta lookups go through
   * these rather than indexing the typed records directly in the template.
   */
  kindInfo(kind: string) {
    return this.kindMeta[kind as ScheduledKind];
  }

  stateInfo(state: string) {
    return this.stateMeta[state as ScheduledState];
  }

  relativeTime(iso: string | null): string {
    if (!iso) return 'Next sweep';
    const then = new Date(iso).getTime();
    const diff = then - Date.now();
    const abs = Math.abs(diff);
    const mins = Math.round(abs / 60000);
    if (mins < 1) return diff < 0 ? 'Now' : 'In under a minute';
    if (mins < 60) return diff < 0 ? `${mins}m overdue` : `In ${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return diff < 0 ? `${hours}h overdue` : `In ${hours}h`;
    const days = Math.round(hours / 24);
    return diff < 0 ? `${days}d overdue` : `In ${days}d`;
  }

  absoluteTime(iso: string | null): string {
    return iso ? new Date(iso).toLocaleString() : 'As soon as the next sweep runs';
  }

  kindCount(kind: ScheduledKind): number {
    return this.summary()?.byKind.find((k) => k.kind === kind)?.total ?? 0;
  }

  /** Campaigns with live leads — the ones producing new work right now. */
  liveGenerators = computed(() => {
    const s = this.summary();
    if (!s) return [];
    return s.generators.campaigns.filter((c) => c.liveLeads > 0 || c.pausedLeads > 0);
  });

  generatorTotal = computed(() => {
    const s = this.summary();
    if (!s) return 0;
    return (
      s.generators.campaigns.reduce((n, c) => n + c.liveLeads, 0) + s.generators.activeGoals.length
    );
  });

  /** Selection is keyed by the composite ref, so it can span every mechanism. */
  rowKey = (row: ScheduledItem) => row.ref;
}
