import { ButtonComponent } from '../../shared/components/button/button.component';
import { Playbook } from '../../core/models/playbook.model';
import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { forkJoin } from 'rxjs';
import { GroupContextService } from '../../core/services/group-context.service';
import { LeadGroupsService } from '../../core/services/lead-groups.service';
import { CampaignsService } from '../../core/services/campaigns.service';
import { PlaybooksService } from '../../core/services/playbooks.service';
import { ExperimentsService } from '../../core/services/experiments.service';
import { ConversationsService } from '../../core/services/conversations.service';
import { Campaign } from '../../core/models/campaign.model';
import { Experiment } from '../../core/models/experiment.model';
import { LeadGroup } from '../../core/models/lead.model';
import { GroupLiveComponent } from './group-live.component';
@Component({ standalone:true, imports:[ButtonComponent, CommonModule, RouterModule, GroupLiveComponent], template:`
  <div class="overview-heading"><div><h1>Move this group forward</h1><p>From finding the right people to learning what gets a reply.</p></div><app-button variant="secondary" size="sm" [link]="context.link('engine')">Work with Engine</app-button></div>
  @if (error()) { <p role="alert">The workspace summary could not load. Try again.</p><app-button (clicked)="load()">Retry</app-button> }
  @if (group(); as g) {
    <div class="stages">
      <a [routerLink]="context.link('leads')"><small>01 · FIND & QUALIFY</small><h2>{{ g.leadCount }} {{ g.leadCount === 1 ? 'lead' : 'leads' }}</h2><p>{{ g.enrichment?.withEmail ?? 0 }} have email addresses. Review enrichment and contact quality before outreach.</p><span>Review prospects →</span></a>
      <a [routerLink]="context.link('playbooks')"><small>02 · PREPARE</small><h2>{{ activePlaybooks() }} active playbooks</h2><p>Check your offer, sender identity, applicable rules and readiness.</p><span>Prepare outreach →</span></a>
      <a [routerLink]="context.link('sandbox')"><small>03 · TEST</small><h2>Rehearse safely</h2><p>Preview a campaign's next email or role-play replies using this group's context.</p><span>Preview & test →</span></a>
      <a [routerLink]="context.link('inbox')"><small>04 · RESPOND & LEARN</small><h2>{{ threads() }} {{ threads() === 1 ? 'conversation' : 'conversations' }}</h2><p>Read replies and inspect each message's campaign, variant and recorded source.</p><span>Handle replies →</span></a>
    </div>
    <section><div class="section-heading"><h2>Outreach for this group</h2><app-button variant="secondary" size="sm" [link]="context.link('campaigns')">Manage campaigns</app-button></div>
      @for (c of campaigns(); track c.id) { <a class="campaign-row" [routerLink]="context.link('campaigns', c.id)"><div><strong>{{ c.name }}</strong><p>Available guidance: {{ guidanceLabel(c.id) }}. Matching depends on the lead and channel.</p><p>{{ c.sequenceEnabled ? 'Fixed approved sequence' : 'AI-directed cadence' }} · {{ c.mode === 'APPROVAL_REQUIRED' ? 'Human approval required' : 'Autonomous' }}</p><p>{{ c.sequenceEnabled ? 'Uses approved steps; no automatic split test.' : experimentLabel(c.id) }}</p></div><span>{{ c.status }}<small>{{ c.leadCount }} enrolled across all groups</small></span></a> }
      @empty { <p>No campaign is linked by enrollment or auto-enrollment. Engine can also send outside a campaign; those messages appear in Replies.</p> }
      <p class="footnote">Campaigns may include leads from more than one group. Playbooks can apply globally, by group, campaign or lead status. Configuration alone does not prove anything was sent.</p>
    </section>
    <app-group-live [groupId]="groupId" />
    <app-button variant="secondary" size="sm" [link]="context.link('experiments')">Compare approaches ({{ experiments().length }})</app-button>
  } @else if (!error()) { <p role="status">Loading workspace summary…</p> }
  `, styles:[`
  h1 { font-size:26px; margin:0 0 8px; } h2 { font-size:18px; margin:10px 0; } p { font-size:13px; line-height:1.6; color:var(--text-secondary); } a { color:var(--text-primary); text-decoration:none; } .overview-heading,.section-heading { display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap; } .stages { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin:22px 0; } .stages>a { padding:20px; border:1px solid var(--border-primary); border-radius:10px; background:var(--bg-secondary); } .stages>a:hover { border-color:var(--text-secondary); } small { font-size:10px; letter-spacing:.05em; color:var(--text-secondary); } .stages span { font-size:13px; } section { padding:18px; border:1px solid var(--border-primary); border-radius:10px; margin-bottom:20px; } .campaign-row { display:flex; justify-content:space-between; gap:16px; padding:14px 0; border-bottom:1px solid var(--border-primary); } .campaign-row p { margin:4px 0; } .campaign-row>span { text-align:right; font-size:12px; } .campaign-row small { display:block; margin-top:7px; } .footnote { font-size:12px; } @media(max-width:1100px) { .stages { grid-template-columns:repeat(2,minmax(0,1fr)); } } @media(max-width:600px) { .stages { grid-template-columns:1fr; } }
  `] })
export class GroupOverviewComponent implements OnInit {
  context = inject(GroupContextService);
  groupId = this.context.currentId();
  private groupsService = inject(LeadGroupsService);
  private campaignsService = inject(CampaignsService);
  private playbooksService = inject(PlaybooksService);
  private experimentsService = inject(ExperimentsService);
  private inbox = inject(ConversationsService);
  group = signal<LeadGroup | null>(null);
  campaigns = signal<Campaign[]>([]);
  experiments = signal<Experiment[]>([]);
  guidance = signal<Playbook[]>([]);
  activePlaybooks = signal(0);
  threads = signal(0);
  error = signal(false);
  ngOnInit(): void { this.load(); }
  load(): void { this.error.set(false); forkJoin({ groups:this.groupsService.list(), campaigns:this.campaignsService.list(this.groupId), playbooks:this.playbooksService.list(this.groupId), experiments:this.experimentsService.list(this.groupId), inbox:this.inbox.listInbox({groupId:this.groupId}) }).subscribe({ next:r => { this.group.set(r.groups.groups.find(g => g.id === this.groupId) ?? null); this.campaigns.set(r.campaigns); this.experiments.set(r.experiments); this.guidance.set(r.playbooks.filter(p => p.isActive)); this.activePlaybooks.set(this.guidance().length); this.threads.set(r.inbox.total); }, error:() => this.error.set(true) }); }
  guidanceLabel(id: string): string { return this.guidance().filter(p => p.scope !== 'CAMPAIGN' || p.campaignId === id).map(p => p.name + (p.scope === 'LEAD_STATUS' ? ' (status-specific)' : '')).join(', ') || 'No active playbook'; }
  experimentLabel(id: string): string { const matches=this.experiments().filter(e => e.status === 'ACTIVE' && (!e.campaignId || e.campaignId === id)); return matches.length ? 'Available tests: ' + matches.map(e => e.name).join(', ') + '. Attribution requires a selected variant on each send.' : 'No active group experiment available. Messages follow the Engine’s instructions.'; }
}
