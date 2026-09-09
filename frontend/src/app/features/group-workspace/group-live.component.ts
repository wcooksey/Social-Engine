import { ButtonComponent } from '../../shared/components/button/button.component';
import { Component, Input, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Subject, timer, switchMap, takeUntil, catchError, of } from 'rxjs';
import { AgentService } from '../../core/services/agent.service';
import { AgentLiveSnapshot } from '../../core/models/live.model';
import { GroupContextService } from '../../core/services/group-context.service';
@Component({ standalone: true, selector: 'app-group-live', imports: [ButtonComponent, CommonModule, RouterModule], template: `
  <details class="group-live" open>
    <summary>Engine activity · {{ live()?.running?.length ?? 0 }} running @if (error()) { · unavailable }</summary>
    @if (live(); as snapshot) {
      @for (run of snapshot.running; track run.id) {
        <div class="run"><span class="pulse">●</span><strong>{{ run.role }}</strong><span>{{ run.currentStep || run.objective }}</span>
          @if (run.chatId) { <app-button variant="secondary" size="sm" [link]="context.link('engine')" [queryParams]="{ chat: run.chatId }">Open conversation</app-button> }
        </div>
      } @empty { <p>No attributed runs active in this group.</p> }
      @for (run of snapshot.recentFinished.slice(0, 2); track run.id) { <details><summary>{{ run.status }} · {{ run.objective | slice:0:110 }}</summary><p>{{ run.summary || 'No summary recorded.' }}</p></details> }
      <small>{{ snapshot.queuedJobs }} queued jobs with group context <app-button variant="secondary" size="sm" link="/live">All groups & unassigned activity</app-button></small>
    } @else { <p>{{ error() ? 'Activity could not be loaded. It will retry automatically.' : 'Loading activity…' }}</p> }
  </details>`, styles: [`
  .group-live { padding:12px 16px; margin-bottom:18px; border:1px solid var(--border-primary); border-radius:8px; font-size:13px; background:var(--bg-secondary); }
  summary { cursor:pointer; } p { margin:8px 0; color:var(--text-secondary); } .run { display:flex; gap:10px; flex-wrap:wrap; margin:10px 0; } .run span:not(.pulse) { flex:1; min-width:160px; } .pulse { color:#22a06b; } small { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin-top:10px; color:var(--text-secondary); }
  `] })
export class GroupLiveComponent implements OnInit, OnDestroy {
  @Input() groupId = '';
  context = inject(GroupContextService);
  private service = inject(AgentService);
  private done = new Subject<void>();
  live = signal<AgentLiveSnapshot | null>(null);
  error = signal(false);
  ngOnInit(): void { timer(0, 5000).pipe(switchMap(() => this.service.getLive(this.groupId).pipe(catchError(() => of(null)))), takeUntil(this.done)).subscribe(result => { this.error.set(!result); this.live.set(result); }); }
  ngOnDestroy(): void { this.done.next(); this.done.complete(); }
}
