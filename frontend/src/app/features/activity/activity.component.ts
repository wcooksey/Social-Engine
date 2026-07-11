import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AgentService } from '../../core/services/agent.service';
import { AgentJob, AgentRole, AgentRun } from '../../core/models/agent.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { DataTableComponent, DataTableCellDirective, DataTableColumn } from '../../shared/components/data-table';
import { DialogComponent } from '../../shared/components/dialog/dialog.component';

@Component({
  selector: 'app-activity',
  standalone: true,
  imports: [CommonModule, CardComponent, BadgeComponent, DataTableComponent, DataTableCellDirective, DialogComponent],
  templateUrl: './activity.component.html',
  styleUrl: './activity.component.scss'
})
export class ActivityComponent implements OnInit {
  runs = signal<AgentRun[]>([]);
  runsTotal = signal(0);
  runsPage = 1;
  readonly runsPageSize = 25;
  loadingRuns = signal(true);

  jobs = signal<AgentJob[]>([]);
  loadingJobs = signal(true);

  selectedRun = signal<AgentRun | null>(null);
  showRunDialog = signal(false);
  loadingRunDetail = signal(false);

  runColumns: DataTableColumn[] = [
    { key: 'objective', header: 'Objective' },
    { key: 'role', header: 'Role' },
    { key: 'trigger', header: 'Trigger' },
    { key: 'model', header: 'Model' },
    { key: 'status', header: 'Status' },
    { key: 'startedAt', header: 'Started' },
    { key: 'duration', header: 'Duration' },
    { key: 'stepCount', header: 'Steps', align: 'right' }
  ];

  constructor(private agentService: AgentService) {}

  ngOnInit(): void {
    this.loadRuns();
    this.loadJobs();
  }

  loadRuns(): void {
    this.loadingRuns.set(true);
    this.agentService.listRuns(this.runsPage).subscribe({
      next: (res) => {
        this.runs.set(res.runs);
        this.runsTotal.set(res.total);
        this.loadingRuns.set(false);
      },
      error: () => this.loadingRuns.set(false)
    });
  }

  onRunsPageChange(page: number): void {
    this.runsPage = page;
    this.loadRuns();
  }

  loadJobs(): void {
    this.loadingJobs.set(true);
    this.agentService.listJobs().subscribe({
      next: (jobs) => {
        this.jobs.set(jobs);
        this.loadingJobs.set(false);
      },
      error: () => this.loadingJobs.set(false)
    });
  }

  openRun(run: AgentRun): void {
    this.showRunDialog.set(true);
    this.loadingRunDetail.set(true);
    this.selectedRun.set(run);
    this.agentService.getRun(run.id).subscribe({
      next: (detail) => {
        this.selectedRun.set(detail);
        this.loadingRunDetail.set(false);
      },
      error: () => this.loadingRunDetail.set(false)
    });
  }

  statusBadgeVariant(status: string): BadgeVariant {
    switch (status) {
      case 'COMPLETED': return 'success';
      case 'FAILED': return 'error';
      case 'RUNNING': return 'info';
      case 'CANCELLED': return 'neutral';
      default: return 'default';
    }
  }

  roleLabel(role: AgentRole): string {
    switch (role) {
      case 'COORDINATOR': return 'Coordinator';
      case 'RESEARCHER': return 'Researcher';
      case 'CALLER': return 'Caller';
      case 'SDR': return 'SDR';
      default: return role;
    }
  }

  roleBadgeVariant(role: AgentRole): BadgeVariant {
    switch (role) {
      case 'COORDINATOR': return 'info';
      case 'RESEARCHER': return 'purple';
      case 'CALLER': return 'orange';
      case 'SDR': return 'success';
      default: return 'default';
    }
  }

  duration(run: AgentRun): string {
    if (!run.finishedAt) return '—';
    const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  }

  formatCost(costUsd: number): string {
    if (costUsd > 0 && costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
    return `$${costUsd.toFixed(2)}`;
  }

  formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
    return `${tokens}`;
  }

  runCostBadge(run: AgentRun): string | null {
    if (run.costUsd == null) return null;
    const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
    return `${this.formatCost(run.costUsd)} · ${this.formatTokens(tokens)} tok`;
  }
}
