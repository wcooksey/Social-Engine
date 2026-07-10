import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { DashboardService } from '../../core/services/dashboard.service';
import { CampaignsService } from '../../core/services/campaigns.service';
import { DashboardStats, FunnelStage } from '../../core/models/dashboard.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { BadgeComponent } from '../../shared/components/badge/badge.component';
import { ChartComponent } from '../../shared/components/chart/chart.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink, CardComponent, BadgeComponent, ChartComponent, SelectComponent],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss'
})
export class DashboardComponent implements OnInit {
  isLoading = signal(true);
  stats = signal<DashboardStats | null>(null);
  chartData: any = null;

  isFunnelLoading = signal(true);
  funnel = signal<FunnelStage[]>([]);
  campaignOptions = signal<SelectOption[]>([]);
  funnelEmpty = computed(() => this.funnel().every(stage => stage.count === 0));

  private statusColors: Record<string, string> = {
    NEW: '#3B82F6',
    RESEARCHING: '#8B5CF6',
    CONTACTED: '#9CA3AF',
    ENGAGED: '#F59E0B',
    INTERESTED: '#10B981',
    NOT_INTERESTED: '#EF4444',
    CUSTOMER: '#10B981',
    ARCHIVED: '#6B7280'
  };

  constructor(
    private dashboardService: DashboardService,
    private campaignsService: CampaignsService
  ) {}

  ngOnInit(): void {
    this.dashboardService.getStats().subscribe({
      next: (stats) => {
        this.stats.set(stats);
        this.buildChart(stats);
        this.isLoading.set(false);
      },
      error: () => {
        this.isLoading.set(false);
      }
    });

    this.loadFunnel();

    this.campaignsService.list().subscribe({
      next: (campaigns) => {
        this.campaignOptions.set(campaigns.map(c => ({ label: c.name, value: c.id })));
      },
      error: () => {
        this.campaignOptions.set([]);
      }
    });
  }

  loadFunnel(campaignId?: string): void {
    this.isFunnelLoading.set(true);
    this.dashboardService.getFunnel(campaignId).subscribe({
      next: (data) => {
        this.funnel.set(data.funnel || []);
        this.isFunnelLoading.set(false);
      },
      error: () => {
        this.funnel.set([]);
        this.isFunnelLoading.set(false);
      }
    });
  }

  onFunnelCampaignChange(campaignId: string | null): void {
    this.loadFunnel(campaignId || undefined);
  }

  funnelBarWidth(count: number): number {
    if (count <= 0) return 0;
    const first = this.funnel()[0]?.count ?? 0;
    if (first <= 0) return 2;
    return Math.max((count / first) * 100, 2);
  }

  funnelConversion(index: number): string | null {
    if (index === 0) return null;
    const prev = this.funnel()[index - 1]?.count ?? 0;
    if (prev <= 0) return null;
    return `${Math.round((this.funnel()[index].count / prev) * 100)}%`;
  }

  private buildChart(stats: DashboardStats): void {
    const entries = Object.entries(stats.leadsByStatus || {}).filter(([, count]) => count > 0);
    this.chartData = {
      labels: entries.map(([status]) => this.statusLabel(status)),
      datasets: [
        {
          data: entries.map(([, count]) => count),
          backgroundColor: entries.map(([status]) => this.statusColors[status] || '#9CA3AF'),
          borderWidth: 0
        }
      ]
    };
  }

  statusLabel(status: string): string {
    return status
      .toLowerCase()
      .split('_')
      .map(w => w[0]?.toUpperCase() + w.slice(1))
      .join(' ');
  }

  statusBadgeVariant(status: string): 'default' | 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'purple' | 'orange' {
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
