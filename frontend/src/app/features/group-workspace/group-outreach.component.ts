import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';
@Component({ standalone: true, imports: [RouterModule], template: `
  <nav aria-label="Outreach workflow" class="workflow-nav">
    <a routerLink="playbooks" routerLinkActive="active">1 · Prepare</a>
    <a routerLink="sandbox" routerLinkActive="active">2 · Preview & test</a>
    <a routerLink="campaigns" routerLinkActive="active">3 · Send</a>
    <a routerLink="experiments" routerLinkActive="active">4 · Learn</a>
  </nav><router-outlet />`, styles: [`
  .workflow-nav { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:24px; }
  a { display:flex; align-items:center; min-height:34px; padding:0 14px; border:1px solid var(--border-primary); border-radius:8px; color:var(--text-secondary); text-decoration:none; font-size:13px; }
  a.active { color:var(--text-primary); background:var(--bg-tertiary); border-color:var(--text-secondary); }
  `] })
export class GroupOutreachComponent {}
