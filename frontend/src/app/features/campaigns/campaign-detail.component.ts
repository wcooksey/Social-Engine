import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CampaignsService } from '../../core/services/campaigns.service';
import {
  Campaign,
  CampaignActivity,
  CampaignLeadEntry,
  CampaignLeadStatus,
  CampaignStatus
} from '../../core/models/campaign.model';
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
    RouterLink,
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
