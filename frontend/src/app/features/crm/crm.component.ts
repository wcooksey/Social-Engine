import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router, RouterLink, ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';
import { CardComponent } from '../../shared/components/card/card.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { ThemeToggleComponent } from '../../shared/components/theme-toggle/theme-toggle.component';
import { DataTableComponent, DataTableCellDirective, DataTableColumn } from '../../shared/components/data-table';

@Component({ selector: 'app-crm', standalone: true, imports: [CommonModule, FormsModule, RouterLink, ButtonComponent, InputComponent, SelectComponent, CardComponent, BadgeComponent, ThemeToggleComponent, DataTableComponent, DataTableCellDirective], templateUrl: './crm.component.html', styleUrl: './crm.component.scss' })
export class CrmComponent implements OnInit {
  api = inject(ApiService); auth = inject(AuthService); http = inject(HttpClient); router = inject(Router); route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);
  private listRequest?: Subscription;
  private detailRequest?: Subscription;
  private context = 0;
  private initialFollowUp = '';
  groups: any[] = []; group: any = null; leads: any[] = []; selected: any = null;
  stats: any[] = []; members: any[] = []; invites: any[] = []; total = 0; page = 1; search = ''; stage = ''; due = false;
  loading = false; detailLoading = false; saving = false; inviting = false; exporting = false;
  error = ''; notice = ''; invitation = ''; inviteEmail = ''; canExport = false;
  importing = false; importPreview: any = null; importCsv = ''; importFile = '';
  kind = 'CALL'; outcome = 'NO_ANSWER'; note = ''; nextStage = ''; followUp = ''; requestId = crypto.randomUUID();
  private pendingSave: { path: string; body: any } | null = null;
  get retryPending() { return !!this.pendingSave && !this.saving; }
  stages = ['NEW','CONTACTED','FOLLOW_UP','INTERESTED','NOT_INTERESTED','WON','DO_NOT_CONTACT'];
  outcomes = ['NO_ANSWER','VOICEMAIL','ANSWERED','WRONG_NUMBER','INTERESTED','NOT_INTERESTED','CALLBACK','DO_NOT_CONTACT'];
  readonly stageOptions: SelectOption[] = this.stages.map(value => ({ value, label: this.label(value) }));
  readonly outcomeOptions: SelectOption[] = this.outcomes.map(value => ({ value, label: this.label(value) }));
  readonly importColumns: DataTableColumn[] = [
    { key: 'companyName', header: 'Company' }, { key: 'contactName', header: 'Contact' },
    { key: 'email', header: 'Email' }, { key: 'contactPhone', header: 'Direct phone' },
  ];
  get activityOptions(): SelectOption[] {
    return [{ value: 'CALL', label: 'Call', disabled: !!this.selected?.doNotContact }, { value: 'NOTE', label: 'Note' }, { value: 'UPDATE', label: 'Pipeline update' }];
  }
  stageVariant(stage: string): BadgeVariant {
    if (['INTERESTED', 'WON'].includes(stage)) return 'success';
    if (stage === 'DO_NOT_CONTACT') return 'error';
    if (stage === 'FOLLOW_UP') return 'warning';
    if (stage === 'CONTACTED') return 'info';
    return 'neutral';
  }
  get manager() { return ['OWNER','ADMIN'].includes(this.auth.currentUser()?.role || ''); }
  locationLabel(lead: any) { return [lead.city, lead.state].filter(Boolean).join(', ') || 'Location not provided'; }
  label(s: string) { return s.replace(/_/g, ' ').toLowerCase(); }

  ngOnInit() {
    this.api.get<any[]>('/api/crm/groups').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: groups => {
        this.groups = groups;
        this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
          this.context++;
          this.listRequest?.unsubscribe(); this.detailRequest?.unsubscribe();
          this.group = groups.find(g => g.id === params.get('groupId'));
          this.selected = null; this.leads = []; this.members = []; this.invites = []; this.stats = [];
          this.invitation = ''; this.notice = ''; this.error = ''; this.page = 1; this.total = 0;
          this.search = ''; this.stage = ''; this.due = false; this.inviteEmail = ''; this.canExport = false;
          this.importPreview = null; this.importCsv = ''; this.importFile = ''; this.pendingSave = null;
          this.loading = this.detailLoading = this.saving = this.inviting = this.importing = false;
          if (this.group) { this.load(); this.loadStats(); if (this.manager) this.loadMembers(); }
          else if (params.get('groupId')) this.error = 'This group is not available to your account.';
        });
      }, error: e => this.fail(e)
    });
  }
  path() { return '/api/crm/groups/' + this.group.id; }
  fail(e: any) { this.error = typeof e.error?.error === 'string' ? e.error.error : 'Could not complete the request. Please try again.'; }
  load(reset = false) {
    if (reset) this.page = 1;
    this.listRequest?.unsubscribe(); this.loading = true; this.error = '';
    this.listRequest = this.api.get<any>(this.path() + '/leads', { page: this.page, search: this.search, stage: this.stage, due: this.due })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: r => { this.leads = r.leads; this.total = r.total; this.loading = false; },
        error: e => { this.loading = false; this.fail(e); }
      });
  }
  open(lead: any) {
    if (this.saving || this.retryPending) return;
    this.detailRequest?.unsubscribe(); this.error = ''; this.selected = null; this.detailLoading = true;
    this.detailRequest = this.api.get<any>(this.path() + '/leads/' + lead.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: r => {
        this.selected = r; this.detailLoading = false; this.kind = r.doNotContact ? 'NOTE' : 'CALL';
        this.outcome = 'NO_ANSWER'; this.note = ''; this.nextStage = r.crmRecord?.stage || 'NEW';
        this.followUp = r.crmRecord?.followUpAt ? this.localDate(r.crmRecord.followUpAt) : '';
        this.initialFollowUp = this.followUp; this.requestId = crypto.randomUUID();
      }, error: e => { this.detailLoading = false; this.fail(e); }
    });
  }
  localDate(value: string) { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,16); }
  save() {
    if (!this.selected || this.saving) return;
    this.saving = true; this.error = ''; const id = this.selected.id; const context = this.context;
    // Retry exactly the original request after an uncertain network failure.
    // An unchanged follow-up is omitted so another caller's schedule is preserved.
    this.pendingSave ||= { path: this.path() + '/leads/' + id + '/events', body: {
      requestId: this.requestId, kind: this.kind, outcome: this.outcome, note: this.note,
      ...(this.kind === 'UPDATE' ? { stage: this.nextStage } : {}),
      ...(this.kind !== 'NOTE' && this.followUp !== this.initialFollowUp ? { followUpAt: this.followUp ? new Date(this.followUp).toISOString() : null } : {})
    } };
    this.api.post(this.pendingSave.path, this.pendingSave.body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        if (context !== this.context) return;
        this.pendingSave = null; this.saving = false; this.notice = 'Activity saved'; this.open({ id }); this.load(); this.loadStats();
      }, error: e => {
        if (context !== this.context) return;
        this.saving = false;
        // Validation/access failures did not commit and may be corrected.
        if (e.status >= 400 && e.status < 500) this.pendingSave = null;
        this.fail(e);
      }
    });
  }
  exportCsv() {
    this.exporting = true; const name = this.group.name;
    this.http.get(this.api.url(this.path() + '/export'), { responseType: 'blob' }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: blob => { this.download(blob, name.replace(/[^a-zA-Z0-9-]/g,'_') + '.csv'); this.exporting = false; },
      error: async e => {
        this.exporting = false;
        if (e.error instanceof Blob) { try { this.fail({ error: JSON.parse(await e.error.text()) }); return; } catch {} }
        this.fail(e);
      }
    });
  }
  download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name;
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  downloadTemplate() {
    this.download(new Blob(['Company,Website,Company phone,Address,City,State,Postal code,Contact,Title,Email,Contact phone\r\nExample Company,https://example.com,+15555550100,123 Main St,Tampa,FL,33602,Pat Smith,Manager,pat@example.com,+15555550101\r\n'], { type: 'text/csv' }), 'contact-import-template.csv');
  }
  async chooseCsv(event: Event) {
    const input = event.target as HTMLInputElement; const file = input.files?.[0]; input.value = '';
    this.importPreview = null; this.importCsv = ''; this.importFile = ''; this.error = '';
    if (!file) return;
    if (file.size > 1_000_000) { this.error = 'CSV must be under 1 MB'; return; }
    this.importing = true; const context = this.context;
    try {
      const csv = await file.text();
      if (context !== this.context) return;
      this.api.post<any>(this.path() + '/import/preview', { csv }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: r => { if (context !== this.context) return; this.importing = false; this.importCsv = csv; this.importFile = file.name; this.importPreview = r; },
        error: e => { if (context !== this.context) return; this.importing = false; this.fail(e); }
      });
    } catch { if (context === this.context) { this.importing = false; this.error = 'Could not read this file'; } }
  }
  importContacts() {
    if (!this.importPreview || this.importing) return;
    this.importing = true; this.error = ''; const context = this.context;
    this.api.post<any>(this.path() + '/import', { csv: this.importCsv }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: r => {
        if (context !== this.context) return;
        this.importing = false; this.importPreview = null; this.importCsv = ''; this.importFile = '';
        this.notice = `Imported ${r.rows} rows: ${r.created} new leads, ${r.updated} existing leads updated, ${r.contactsCreated} new contacts.`;
        this.group.leadCount += r.created; this.load(true); if (this.selected) this.open(this.selected);
      }, error: e => { if (context !== this.context) return; this.importing = false; this.fail(e); }
    });
  }
  loadStats() {
    const context = this.context;
    this.api.get<any[]>(this.path() + '/stats').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: r => { if (context === this.context) this.stats = r; }, error: e => { if (context === this.context) this.fail(e); } });
  }
  loadMembers() {
    const context = this.context;
    this.api.get<any>(this.path() + '/members').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: r => { if (context === this.context) { this.members = r.members; this.invites = r.invites; } }, error: e => { if (context === this.context) this.fail(e); } });
  }
  invite() {
    if (this.inviting) return;
    this.inviting = true; this.error = ''; this.invitation = ''; const context = this.context;
    this.api.post<any>(this.path() + '/invites', { email: this.inviteEmail, canExport: this.canExport }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: r => {
        if (context !== this.context) return;
        this.inviting = false; this.invitation = r.inviteUrl || '';
        this.notice = r.granted ? 'Existing caller access updated' : 'Invitation created. Share the link with this person; it expires in seven days.'; this.loadMembers();
      }, error: e => { if (context !== this.context) return; this.inviting = false; this.fail(e); }
    });
  }
  revoke(type: string, id: string) {
    const context = this.context;
    this.api.delete(this.path() + '/' + type + '/' + id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { if (context === this.context) this.loadMembers(); }, error: e => { if (context === this.context) this.fail(e); } });
  }
  logout() { this.api.post('/api/auth/logout').subscribe({ next: () => { this.auth.logout(); this.router.navigate(['/crm/login']); }, error: e => this.fail(e) }); }
  verified(c: any) { return !c.optedOut && !c.emailStatus && c.email && c.emailVerifiedAddress?.toLowerCase() === c.email.toLowerCase() && c.emailVerifiedAt && Date.now() - new Date(c.emailVerifiedAt).getTime() < 30*86400000; }
  website(url: string) { return /^https?:\/\//i.test(url || '') ? url : null; }
}
