import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AgentService } from '../../core/services/agent.service';
import { AgentRole, AgentRunStep } from '../../core/models/agent.model';
import {
  AgentLiveSnapshot,
  LiveBrowserAction,
  LiveBrowserFrame,
  LiveBrowserState,
  LiveRunningAgent
} from '../../core/models/live.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { EngineService } from '../../core/services/engine.service';
import { ToastService } from '../../core/services/toast.service';
import { RunControlAction } from '../../core/models/engine.model';

@Component({
  selector: 'app-live',
  standalone: true,
  imports: [CommonModule, CardComponent, BadgeComponent],
  templateUrl: './live.component.html',
  styleUrl: './live.component.scss'
})
export class LiveComponent implements OnInit, OnDestroy {
  private static readonly POLL_INTERVAL_MS = 3_000;
  private static readonly MAX_VISIBLE_STEPS = 8;
  private static readonly MAX_VISIBLE_ACTIONS = 5;

  live = signal<AgentLiveSnapshot | null>(null);
  loading = signal(true);
  frames = signal<Record<string, LiveBrowserFrame>>({});
  now = signal(Date.now());
  /** Runs with a stop in flight, so the button can't be double-fired. */
  stopping = signal<Set<string>>(new Set<string>());
  stoppingAll = signal(false);

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private fetchingLive = false;
  private fetchingFrames = new Set<string>();

  constructor(
    private agentService: AgentService,
    private engineService: EngineService,
    private toast: ToastService
  ) {}

  /**
   * Stop one agent, whether or not it is still responding.
   *
   * The server picks the mechanism: a live run halts at its next step boundary,
   * while one stranded by a restart has its record closed directly. Routing
   * both through a single endpoint is what makes the button work on the agents
   * that previously had none.
   */
  stopRun(run: LiveRunningAgent): void {
    if (this.stopping().has(run.id)) return;
    this.stopping.update((s) => new Set(s).add(run.id));

    this.agentService.stopRun(run.id).subscribe({
      next: (result) => {
        this.stopping.update((s) => {
          const next = new Set(s);
          next.delete(run.id);
          return next;
        });
        this.toast.info(result?.note || 'Stopped');
        this.fetchLive();
      },
      error: () => {
        this.stopping.update((s) => {
          const next = new Set(s);
          next.delete(run.id);
          return next;
        });
        this.toast.error('Could not stop that agent');
      }
    });
  }

  /** Stop everything for this org — live agents and stranded records alike. */
  stopAll(): void {
    if (this.stoppingAll()) return;
    const count = this.runningCount();
    if (!confirm(`Stop all ${count} running agent${count === 1 ? '' : 's'}?`)) return;

    this.stoppingAll.set(true);
    this.agentService.stopAllRuns().subscribe({
      next: (result) => {
        this.stoppingAll.set(false);
        this.toast.info(result?.note || 'Stopped all agents');
        this.fetchLive();
      },
      error: () => {
        this.stoppingAll.set(false);
        this.toast.error('Could not stop the running agents');
      }
    });
  }

  /**
   * Drive a running agent from the fleet view. Optimistically reflects the new
   * phase so the card responds immediately, then the next poll confirms it.
   */
  control(run: LiveRunningAgent, action: RunControlAction): void {
    this.engineService.control(run.id, action).subscribe({
      next: () => {
        if (action === 'cancel') this.toast.info('Stopping after the current step finishes');
        this.live.update((snapshot) => {
          if (!snapshot) return snapshot;
          return {
            ...snapshot,
            running: snapshot.running.map((r) =>
              r.id !== run.id
                ? r
                : {
                    ...r,
                    watch: action === 'watch_on' ? true : action === 'watch_off' ? false : r.watch,
                    phase:
                      action === 'pause'
                        ? 'paused'
                        : action === 'cancel'
                          ? 'cancelling'
                          : action === 'resume' || action === 'step'
                            ? 'running'
                            : r.phase
                  }
            )
          };
        });
        this.tickNow();
      },
      error: () => this.toast.error('That run is no longer live')
    });
  }

  private tickNow(): void {
    setTimeout(() => this.fetchLive(), 400);
  }

  ngOnInit(): void {
    this.tick();
    this.pollHandle = setInterval(() => this.tick(), LiveComponent.POLL_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private tick(): void {
    this.now.set(Date.now());
    this.fetchLive();
  }

  private fetchLive(): void {
    if (this.fetchingLive) return;
    this.fetchingLive = true;
    this.agentService.getLive().subscribe({
      next: (snapshot) => {
        this.fetchingLive = false;
        this.live.set(snapshot);
        this.loading.set(false);
        this.pruneFrames(snapshot);
        this.fetchFrames(snapshot);
      },
      error: () => {
        this.fetchingLive = false;
        this.loading.set(false);
      }
    });
  }

  /** Drop cached frames for runs that are no longer running. */
  private pruneFrames(snapshot: AgentLiveSnapshot): void {
    const runningIds = new Set(snapshot.running.map(run => run.id));
    const current = this.frames();
    const kept: Record<string, LiveBrowserFrame> = {};
    let changed = false;
    for (const [id, frame] of Object.entries(current)) {
      if (runningIds.has(id)) {
        kept[id] = frame;
      } else {
        changed = true;
      }
    }
    if (changed) this.frames.set(kept);
  }

  /** Fetch the latest browser screenshot for runs that have one. 404s are ignored. */
  private fetchFrames(snapshot: AgentLiveSnapshot): void {
    for (const run of snapshot.running) {
      if (!run.browser?.hasFrame || this.fetchingFrames.has(run.id)) continue;
      this.fetchingFrames.add(run.id);
      this.agentService.getLiveFrame(run.id).subscribe({
        next: (frame) => {
          this.fetchingFrames.delete(run.id);
          this.frames.update(frames => ({ ...frames, [run.id]: frame }));
        },
        // No frame yet (404) — handle silently.
        error: () => this.fetchingFrames.delete(run.id)
      });
    }
  }

  runningCount(): number {
    return this.live()?.running.length ?? 0;
  }

  queuedJobs(): number {
    return this.live()?.queuedJobs ?? 0;
  }

  frameFor(runId: string): LiveBrowserFrame | null {
    return this.frames()[runId] ?? null;
  }

  frameSrc(frame: LiveBrowserFrame): string {
    return 'data:image/jpeg;base64,' + frame.imageBase64;
  }

  visibleSteps(run: LiveRunningAgent): AgentRunStep[] {
    return (run.steps ?? []).slice(-LiveComponent.MAX_VISIBLE_STEPS);
  }

  recentBrowserActions(browser: LiveBrowserState): LiveBrowserAction[] {
    return (browser.actions ?? []).slice(-LiveComponent.MAX_VISIBLE_ACTIONS);
  }

  stepIcon(type: string): string {
    switch (type) {
      case 'tool_call': return 'bi-wrench';
      case 'message': return 'bi-chat-text';
      case 'model_failover': return 'bi-arrow-repeat';
      default: return 'bi-circle';
    }
  }

  stepInput(step: AgentRunStep): string {
    if (step.input == null) return '';
    const raw = typeof step.input === 'string' ? step.input : JSON.stringify(step.input);
    if (!raw || raw === '{}') return '';
    return raw.length > 100 ? `${raw.slice(0, 100)}…` : raw;
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

  statusBadgeVariant(status: string): BadgeVariant {
    switch (status) {
      case 'COMPLETED': return 'success';
      case 'FAILED': return 'error';
      case 'RUNNING': return 'info';
      case 'CANCELLED': return 'neutral';
      default: return 'default';
    }
  }

  runningDuration(run: LiveRunningAgent): string {
    const ms = this.now() - new Date(run.startedAt).getTime();
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  relativeTime(iso: string): string {
    const seconds = Math.max(0, Math.round((this.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  formatCost(costUsd: number): string {
    if (costUsd > 0 && costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
    return `$${costUsd.toFixed(2)}`;
  }
}
