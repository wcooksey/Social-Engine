import { Component, DestroyRef, EventEmitter, Input, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { DialogComponent } from '../../shared/components/dialog/dialog.component';
import { BadgeComponent } from '../../shared/components/badge/badge.component';

interface CallerAccount {
  id: string; email: string; firstName: string; lastName: string; isActive: boolean;
  crmGrants: { groupId: string; canExport: boolean; group: { name: string } }[];
}
@Component({
  selector: 'app-crm-accounts', standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent, InputComponent, DialogComponent, BadgeComponent],
  templateUrl: './crm-accounts.component.html', styleUrl: './crm-accounts.component.scss',
})
export class CrmAccountsComponent {
  @Input() groups: { id: string; name: string }[] = [];
  @Input() defaultGroupId?: string;
  @Output() changed = new EventEmitter<void>();
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private request?: Subscription;
  private scrollY = 0;
  show = false; loading = false; saving = false; error = ''; notice = '';
  mode: 'list' | 'create' | 'edit' | 'credentials' = 'list';
  accounts: CallerAccount[] = [];
  editing: CallerAccount | null = null;
  firstName = ''; lastName = ''; email = ''; password = ''; credentials = '';
  selected: Record<string, boolean> = {}; exports: Record<string, boolean> = {};
  get title() { return this.mode === 'create' ? 'Create caller account' : this.mode === 'edit' ? 'Edit group access' : this.mode === 'credentials' ? 'Caller account created' : 'Caller accounts'; }
  get selectedCount() { return this.groups.filter(g => this.selected[g.id]).length; }
  private reveal() { if (!this.show) this.scrollY = window.scrollY; this.show = true; }
  private clearSecrets() { this.password = ''; this.credentials = ''; }
  open(editId?: string) {
    if (this.saving) return;
    this.request?.unsubscribe(); this.clearSecrets(); this.reveal(); this.mode = 'list'; this.accounts = []; this.error = ''; this.notice = ''; this.loading = true;
    this.request = this.api.get<CallerAccount[]>('/api/crm/accounts').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: accounts => {
        this.accounts = accounts; this.loading = false;
        if (editId) { const account = accounts.find(a => a.id === editId); if (account) this.edit(account); else this.error = 'Caller account is no longer available.'; }
      }, error: e => { this.loading = false; this.fail(e); },
    });
  }
  create() {
    if (this.saving) return;
    this.request?.unsubscribe(); this.reveal(); this.mode = 'create'; this.loading = false; this.error = ''; this.notice = ''; this.clearSecrets();
    this.editing = null; this.firstName = ''; this.lastName = ''; this.email = ''; this.selected = {}; this.exports = {};
    if (this.defaultGroupId) this.selected[this.defaultGroupId] = true;
    this.generatePassword();
  }
  generatePassword() { this.password = crypto.randomUUID().replace(/-/g, ''); }
  edit(account: CallerAccount) {
    if (this.saving || !account.isActive) return;
    this.clearSecrets(); this.mode = 'edit'; this.error = ''; this.notice = ''; this.editing = account; this.selected = {}; this.exports = {};
    for (const grant of account.crmGrants) { this.selected[grant.groupId] = true; this.exports[grant.groupId] = grant.canExport; }
  }
  save() {
    if (this.saving || !['create', 'edit'].includes(this.mode)) return;
    const creating = this.mode === 'create';
    const grants = this.groups.filter(g => this.selected[g.id]).map(g => ({ groupId: g.id, canExport: !!this.exports[g.id] }));
    if (creating && !grants.length) { this.error = 'Choose at least one contact group.'; return; }
    this.saving = true; this.error = ''; this.notice = '';
    const password = this.password;
    const call = creating
      ? this.api.post<CallerAccount>('/api/crm/accounts', { email: this.email, password, firstName: this.firstName, lastName: this.lastName, grants })
      : this.api.patch<CallerAccount>('/api/crm/accounts/' + this.editing!.id + '/groups', { grants });
    this.request = call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: account => {
        this.saving = false; this.changed.emit();
        if (creating) {
          this.credentials = `CRM sign in: ${window.location.origin}/crm/login\nEmail: ${account.email}\nPassword: ${password}`;
          this.password = ''; this.mode = 'credentials';
        } else { this.open(); this.notice = 'Group access updated.'; }
      }, error: e => {
        this.saving = false;
        if (creating && (!e.status || e.status >= 500)) this.error = 'Could not confirm account creation. Check Caller accounts before trying again. If it was created, the password you entered still applies.';
        else this.fail(e);
      },
    });
  }
  async copyCredentials() {
    try { await navigator.clipboard.writeText(this.credentials); if (this.show && this.mode === 'credentials') this.notice = 'Sign-in details copied.'; }
    catch { this.error = 'Copy was unavailable. Select and copy the sign-in details below.'; }
  }
  close() {
    if (this.saving) return;
    this.request?.unsubscribe(); this.clearSecrets(); this.show = false;
    requestAnimationFrame(() => window.scrollTo({ top: this.scrollY, behavior: 'instant' }));
  }
  private fail(e: any) { this.error = typeof e.error?.error === 'string' ? e.error.error : 'Could not complete the request. Please try again.'; }
}
