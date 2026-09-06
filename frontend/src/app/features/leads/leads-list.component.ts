import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { debounceTime, distinctUntilChanged, Subject } from 'rxjs';
import { LeadsService } from '../../core/services/leads.service';
import { LeadGroupsService } from '../../core/services/lead-groups.service';
import {
  ENRICHMENT_TIERS,
  ENRICHMENT_TIER_HINT,
  ENRICHMENT_TIER_LABEL,
  EnrichmentStats,
  EnrichmentTier,
  Lead,
  LeadGroup,
  UNGROUPED_ID,
  LeadsQuery,
  formatLeadAddress
} from '../../core/models/lead.model';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { DialogComponent } from '../../shared/components/dialog/dialog.component';
import { DataTableComponent, DataTableCellDirective, DataTableColumn, DataTableSort } from '../../shared/components/data-table';
import { ToastService } from '../../core/services/toast.service';

/** Saved-filter presets for the common "which leads are workable?" questions. */
type QualityFilter = '' | 'needs' | 'ready' | 'no_email' | 'has_email' | 'multi_email' | 'no_phone';

@Component({
  selector: 'app-leads-list',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonComponent,
    InputComponent,
    SelectComponent,
    BadgeComponent,
    DialogComponent,
    DataTableComponent,
    DataTableCellDirective
  ],
  templateUrl: './leads-list.component.html',
  styleUrl: './leads-list.component.scss'
})
export class LeadsListComponent implements OnInit {
  leads = signal<Lead[]>([]);
  total = signal(0);
  loading = signal(false);
  groups = signal<LeadGroup[]>([]);
  /** Leads left behind by a deleted group — reachable via the Ungrouped filter. */
  ungroupedLeads = signal(0);
  stats = signal<EnrichmentStats | null>(null);
  recomputing = signal(false);

  search = '';
  status = '';
  groupId = '';
  /** Selected tier chip ('' = all tiers). */
  tier: EnrichmentTier | '' = '';
  quality: QualityFilter = '';
  sort: DataTableSort | null = null;
  page = 1;
  pageSize = 20;

  readonly tiers = ENRICHMENT_TIERS;
  readonly tierLabel = ENRICHMENT_TIER_LABEL;
  readonly tierHint = ENRICHMENT_TIER_HINT;

  showAddDialog = signal(false);
  savingLead = signal(false);
  newLead = {
    companyName: '',
    website: '',
    phone: '',
    // Sourced leads have carried a street address all along; without this field
    // a hand-added lead could never have one, so the header would show city and
    // state forever no matter what the detail page is now able to display.
    address: '',
    city: '',
    state: '',
    industry: '',
    groupId: ''
  };

  columns: DataTableColumn[] = [
    { key: 'companyName', header: 'Company' },
    { key: 'location', header: 'Location' },
    { key: 'enrichment', header: 'Enrichment', sortable: true },
    { key: 'reach', header: 'Reachable via' },
    { key: 'status', header: 'Status' },
    { key: 'group', header: 'Group' },
    { key: 'createdAt', header: 'Created' }
  ];

  private searchInput$ = new Subject<string>();

  statusOptions: SelectOption[] = [
    { label: 'New', value: 'NEW' },
    { label: 'Researching', value: 'RESEARCHING' },
    { label: 'Contacted', value: 'CONTACTED' },
    { label: 'Engaged', value: 'ENGAGED' },
    { label: 'Interested', value: 'INTERESTED' },
    { label: 'Not Interested', value: 'NOT_INTERESTED' },
    { label: 'Customer', value: 'CUSTOMER' },
    { label: 'Archived', value: 'ARCHIVED' }
  ];

  qualityOptions: SelectOption[] = [
    { label: 'Needs enrichment', value: 'needs' },
    { label: 'Well researched (not send readiness)', value: 'ready' },
    { label: 'No email', value: 'no_email' },
    { label: 'Has an email', value: 'has_email' },
    { label: '2+ emails', value: 'multi_email' },
    { label: 'No phone', value: 'no_phone' }
  ];

  /**
   * Groups, plus the orphan pool when there is one.
   *
   * Deleting a group unlinks its leads instead of destroying them, so without
   * this entry those leads are unreachable from here — present in every total,
   * absent from every filter. That gap is what makes a total look "stuck"
   * after a group is deleted.
   */
  get groupOptions(): SelectOption[] {
    const options: SelectOption[] = this.groups().map(g => ({ label: g.name, value: g.id }));
    const orphans = this.ungroupedLeads();
    if (orphans > 0) {
      options.push({ label: `Ungrouped (${orphans})`, value: UNGROUPED_ID });
    }
    return options;
  }

  /** Group options for ASSIGNING a lead — the orphan pool is not a destination. */
  get assignableGroupOptions(): SelectOption[] {
    return this.groups().map(g => ({ label: g.name, value: g.id }));
  }

  constructor(
    private leadsService: LeadsService,
    private leadGroupsService: LeadGroupsService,
    private router: Router,
    private route: ActivatedRoute,
    private toast: ToastService
  ) {
    this.searchInput$.pipe(debounceTime(300), distinctUntilChanged()).subscribe(value => {
      this.search = value;
      this.page = 1;
      this.syncUrl();
      this.load();
    });
  }

  ngOnInit(): void {
    // Filters are restored from the URL, not just groupId — the URL is the
    // single source of truth for what this list is showing, so a reload, a
    // bookmark, a shared link and the browser Back button all land on the same
    // filtered view instead of silently falling back to every lead in the org.
    const params = this.route.snapshot.queryParamMap;
    this.groupId = params.get('groupId') || '';
    this.status = params.get('status') || '';
    this.search = params.get('search') || '';
    this.tier = (params.get('tier') as EnrichmentTier) || '';
    this.quality = (params.get('quality') as QualityFilter) || '';
    this.page = Number(params.get('page')) || 1;

    this.leadGroupsService.list().subscribe(res => {
      this.groups.set(res.groups);
      this.ungroupedLeads.set(res.ungroupedLeads);
    });
    this.load();
    this.loadStats();
  }

  /**
   * Mirror the current filters into the URL. `replaceUrl` keeps this out of the
   * history stack — ticking through four filters shouldn't cost four presses of
   * Back to leave the page — while still leaving the address bar accurate for
   * whenever we DO push a new entry (opening a lead).
   */
  private syncUrl(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        groupId: this.groupId || null,
        status: this.status || null,
        search: this.search || null,
        tier: this.tier || null,
        quality: this.quality || null,
        page: this.page > 1 ? this.page : null,
      },
      replaceUrl: true,
    });
  }

  onSearchChange(value: string): void {
    this.searchInput$.next(value);
  }

  onFilterChange(): void {
    this.page = 1;
    this.syncUrl();
    this.load();
    this.loadStats();
  }

  onPageChange(page: number): void {
    this.page = page;
    this.syncUrl();
    this.load();
  }

  /** Server-side sort — the table only reflects the state and emits changes. */
  onSortChange(sort: DataTableSort | null): void {
    this.sort = sort;
    this.page = 1;
    this.load();
  }

  /** Clicking a tier chip filters to it; clicking the active one clears it. */
  selectTier(tier: EnrichmentTier | ''): void {
    this.tier = this.tier === tier ? '' : tier;
    // A tier chip and a preset would fight over the same columns — chips win.
    if (this.tier) this.quality = '';
    this.page = 1;
    this.syncUrl();
    this.load();
  }

  onQualityChange(): void {
    if (this.quality) this.tier = '';
    this.page = 1;
    this.syncUrl();
    this.load();
  }

  private buildQuery(): LeadsQuery {
    const query: LeadsQuery = {
      search: this.search || undefined,
      status: this.status || undefined,
      groupId: this.groupId || undefined,
      page: this.page,
      pageSize: this.pageSize
    };

    if (this.tier) query.tier = this.tier;

    switch (this.quality) {
      case 'needs':
        query.maxTier = 'PARTIAL';
        break;
      case 'ready':
        query.minTier = 'GOOD';
        break;
      case 'no_email':
        query.hasEmail = false;
        break;
      case 'has_email':
        query.hasEmail = true;
        break;
      case 'multi_email':
        query.multipleEmails = true;
        break;
      case 'no_phone':
        query.hasPhone = false;
        break;
    }

    if (this.sort) {
      query.sort = this.sort.key === 'enrichment' ? 'score' : this.sort.key === 'companyName' ? 'company' : 'created';
      query.sortDir = this.sort.direction;
    }
    return query;
  }

  load(): void {
    this.loading.set(true);
    this.leadsService.list(this.buildQuery()).subscribe({
      next: (res) => {
        this.leads.set(res.leads);
        this.total.set(res.total);
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  /** Breakdown for the current group scope — the chip counts above the table. */
  loadStats(): void {
    this.leadsService.enrichmentStats(this.groupId || undefined).subscribe({
      next: (stats) => this.stats.set(stats),
      error: () => this.stats.set(null)
    });
  }

  tierCount(tier: EnrichmentTier): number {
    return this.stats()?.tiers?.[tier] ?? 0;
  }

  /** Percentage of the scoped list in a tier — drives the chip's fill bar. */
  tierShare(tier: EnrichmentTier): number {
    const total = this.stats()?.totalLeads || 0;
    if (!total) return 0;
    return Math.round((this.tierCount(tier) / total) * 100);
  }

  /** Rebuild scores after a bulk change (or a scoring tweak) without a redeploy. */
  recompute(): void {
    this.recomputing.set(true);
    this.leadsService.recomputeEnrichment(this.groupId || undefined).subscribe({
      next: (res) => {
        this.recomputing.set(false);
        this.toast.success(`Rescored ${res.leads} lead${res.leads === 1 ? '' : 's'}`);
        this.load();
        this.loadStats();
      },
      error: () => {
        this.recomputing.set(false);
        this.toast.error('Failed to rescore leads');
      }
    });
  }

  openAddDialog(): void {
    this.newLead = { companyName: '', website: '', phone: '', address: '', city: '', state: '', industry: '', groupId: '' };
    this.showAddDialog.set(true);
  }

  submitNewLead(): void {
    if (!this.newLead.companyName.trim()) return;
    this.savingLead.set(true);
    const payload = { ...this.newLead };
    if (!payload.groupId) delete (payload as any).groupId;
    this.leadsService.create(payload).subscribe({
      next: () => {
        this.savingLead.set(false);
        this.showAddDialog.set(false);
        this.toast.success('Lead created');
        this.load();
        this.loadStats();
      },
      error: () => {
        this.savingLead.set(false);
        this.toast.error('Failed to create lead');
      }
    });
  }

  goToLead(lead: Lead): void {
    // Hand the detail page the exact list we are leaving, so its "Back to
    // Leads" returns to this group and these filters. Router state rather than
    // a query param: it keeps the lead's own URL clean and shareable, and the
    // browser persists it across a reload of the detail page.
    this.router.navigate(['/leads', lead.id], { state: { returnUrl: this.router.url } });
  }

  statusBadgeVariant(status: string): BadgeVariant {
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

  /** Table rows come through the cell templates untyped — resolve labels here. */
  tierLabelFor(lead: Lead): string {
    return lead.enrichmentTier ? this.tierLabel[lead.enrichmentTier] : '—';
  }

  tierHintFor(lead: Lead): string {
    return lead.enrichmentTier ? this.tierHint[lead.enrichmentTier] : '';
  }

  tierBadgeVariant(tier?: EnrichmentTier): BadgeVariant {
    switch (tier) {
      case 'RICH': return 'success';
      case 'GOOD': return 'info';
      case 'PARTIAL': return 'warning';
      case 'MINIMAL': return 'orange';
      case 'NONE': return 'error';
      default: return 'neutral';
    }
  }

  location(lead: Lead): string {
    return [lead.city, lead.state].filter(Boolean).join(', ') || '—';
  }

  /**
   * Full address for the location cell's tooltip. The column stays as city and
   * state so the table doesn't blow out to a street line per row, but the
   * street is one hover away rather than only on the detail page.
   */
  fullAddress(lead: Lead): string {
    return formatLeadAddress(lead);
  }

  /** "2 emails · 1 phone" — the concrete answer to "can we contact them?". */
  reachSummary(lead: Lead): string {
    const parts: string[] = [];
    const emails = lead.emailCount ?? 0;
    const phones = lead.phoneCount ?? 0;
    if (emails) parts.push(`${emails} email${emails === 1 ? '' : 's'}`);
    if (phones) parts.push(`${phones} phone${phones === 1 ? '' : 's'}`);
    return parts.join(' · ') || 'No channel';
  }
}
