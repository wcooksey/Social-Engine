import { ButtonComponent } from '../../shared/components/button/button.component';
import { Component, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { Subscription, switchMap, tap, map } from 'rxjs';
import { LeadGroupsService } from '../../core/services/lead-groups.service';
import { LeadGroup } from '../../core/models/lead.model';

@Component({
  standalone: true,
  imports: [ButtonComponent, CommonModule, FormsModule, RouterModule],
  template: `
    <header class="workspace-header">
      <app-button variant="secondary" size="sm" icon="bi-arrow-left" link="/groups">All groups</app-button>
      <label>Group workspace
        <select aria-label="Switch group" [ngModel]="group()?.id || ''" (ngModelChange)="switchGroup($event)">
          @for (g of groups(); track g.id) { <option [value]="g.id">{{ g.name }}</option> }
        </select>
      </label>
      @if (group(); as g) { <p>{{ g.goal }}</p> }
    </header>
    @if (error()) { <p role="alert">{{ error() }}</p><app-button variant="secondary" link="/groups">Return to groups</app-button> }
    @else if (group()) { <router-outlet /> }
    @else { <p role="status">Loading group workspace…</p> }
  `,
  styles: [`
    .workspace-header { display:flex; align-items:center; gap:20px; flex-wrap:wrap; padding:0 0 18px; margin-bottom:20px; border-bottom:1px solid var(--border-primary); }
    label { display:flex; flex-direction:column; gap:5px; font-size:12px; color:var(--text-secondary); }
    select { min-width:220px; max-width:100%; height:34px; padding:4px 10px; border:1px solid var(--border-primary); border-radius:8px; background:var(--bg-input); color:var(--text-primary); }
    p { flex:1; min-width:180px; margin:0; color:var(--text-secondary); font-size:13px; }
    a { color:var(--text-secondary); font-size:13px; }
  `]
})
export class GroupWorkspaceComponent implements OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private service = inject(LeadGroupsService);
  groups = signal<LeadGroup[]>([]);
  group = signal<LeadGroup | null>(null);
  error = signal('');
  private sub: Subscription = this.route.paramMap.pipe(
    tap(() => { this.group.set(null); this.error.set(''); }),
    switchMap(params => this.service.list().pipe(mapGroups(params.get('groupId')!)))
  ).subscribe({ next: ({ groups, id }) => {
    this.groups.set(groups);
    this.group.set(groups.find(g => g.id === id) ?? null);
    if (!this.group()) this.error.set('This group is unavailable or has been deleted.');
  }, error: () => this.error.set('Could not load this group. Return to groups and try again.') });
  switchGroup(id: string): void { void this.router.navigate(['/groups', id]); }
  ngOnDestroy(): void { this.sub.unsubscribe(); }
}
const mapGroups = (id: string) => map((result: { groups: LeadGroup[] }) => ({ groups: result.groups, id }));
