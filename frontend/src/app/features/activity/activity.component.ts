import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AgentService } from '../../core/services/agent.service';
import { AgentJob, AgentRun } from '../../core/models/agent.model';
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
  loadingRuns = signal(true);

  jobs = signal<AgentJob[]>([]);
  loadingJobs = signal(true);

  selectedRun = signal<AgentRun | null>(null);
  showRunDialog = signal(false);
  loadingRunDetail = signal(false);

  runColumns: DataTableColumn[] = [
    { key: 'objective', header: 'Objective' },
    { key: 'trigger', header: 'Trigger' },
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
    this.agentService.listRuns(1).subscribe({
      next: (res) => {
        this.runs.set(res.runs);
        this.loadingRuns.set(false);
      },
      error: () => this.loadingRuns.set(false)
    });
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

  duration(run: AgentRun): string {
    if (!run.finishedAt) return '—';
    const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  }
}
