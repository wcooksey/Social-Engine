import { inject } from '@angular/core';
import { GroupContextService } from '../../core/services/group-context.service';
import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { PlaybooksService, PlaybookInput } from '../../core/services/playbooks.service';
import {
  EmailTransport,
  Playbook,
  PlaybookReadiness,
  PlaybookChannel,
  PlaybookScope,
  hasIdentity
} from '../../core/models/playbook.model';
import { SendingService } from '../../core/services/sending.service';
import { GmailAccount } from '../../core/models/sending.model';
import { LeadGroupsService } from '../../core/services/lead-groups.service';
import { CampaignsService } from '../../core/services/campaigns.service';
import { LeadStatus } from '../../core/models/lead.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { DialogComponent } from '../../shared/components/dialog/dialog.component';
import { SwitchComponent } from '../../shared/components/switch/switch.component';
import { ToastService } from '../../core/services/toast.service';

const LEAD_STATUSES: LeadStatus[] = [
  'NEW',
  'RESEARCHING',
  'CONTACTED',
  'ENGAGED',
  'INTERESTED',
  'NOT_INTERESTED',
  'CUSTOMER',
  'ARCHIVED'
];

@Component({
  selector: 'app-playbooks',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    CardComponent,
    ButtonComponent,
    InputComponent,
    SelectComponent,
    BadgeComponent,
    DialogComponent,
    SwitchComponent
  ],
  templateUrl: './playbooks.component.html',
  styleUrl: './playbooks.component.scss'
})
export class PlaybooksComponent implements OnInit {
  context = inject(GroupContextService);
  readonly workspaceGroupId = this.context.currentId();

  readiness = signal<PlaybookReadiness | null>(null);
  readinessOpen = signal(false);
  readinessLoading = signal(false);
  readinessError = signal('');
  inspectReadiness(playbook: Playbook): void {
    this.readiness.set(null); this.readinessOpen.set(true); this.readinessLoading.set(true); this.readinessError.set('');
    this.playbooksService.readiness(playbook.id).subscribe({ next: result => { this.readiness.set(result); this.readinessLoading.set(false); }, error: err => { this.readinessError.set(err.error?.error || err.error?.message || 'Could not check readiness. Try again.'); this.readinessLoading.set(false); } });
  }
  playbooks = signal<Playbook[]>([]);
  loading = signal(true);

  /**
   * Multi-select for clearing out a whole line of business at once. Retiring a
   * vertical means deleting every playbook that belongs to it, and doing that
   * one card and one confirm at a time is the kind of chore people abandon
   * halfway — leaving stale protocols in every future run's prompt.
   */
  selectedIds = signal<Set<string>>(new Set<string>());
  bulkDeleting = signal(false);

  showDialog = signal(false);
  saving = signal(false);
  // Identity is an advanced option — collapsed unless the playbook uses one.
  showIdentity = signal(false);
  editingPlaybook: Playbook | null = null;

  groupOptions: SelectOption[] = [];
  campaignOptions: SelectOption[] = [];

  scopeOptions: SelectOption[] = [
    { label: 'Everything (Global)', value: 'GLOBAL' },
    { label: 'Lead Group', value: 'GROUP' },
    { label: 'Campaign', value: 'CAMPAIGN' },
    { label: 'Lead Status', value: 'LEAD_STATUS' }
  ];

  channelOptions: SelectOption[] = [
    { label: 'Any channel', value: 'ALL' },
    { label: 'Email', value: 'EMAIL' },
    { label: 'SMS', value: 'SMS' },
    { label: 'Voice', value: 'VOICE' }
  ];

  leadStatusOptions: SelectOption[] = LEAD_STATUSES.map(status => ({ label: status, value: status }));

  /**
   * Connected Gmail inboxes, for the "where does this send from" choice. Loaded
   * on the playbooks page rather than only on Sending, because the decision is
   * made here and an operator should not have to go and look up whether they
   * have an inbox before they can answer it.
   */
  inboxes = signal<GmailAccount[]>([]);

  transportOptions: SelectOption[] = [
    { label: 'Sending domains (Mailgun)', value: 'MAILGUN' },
    { label: 'A Gmail inbox', value: 'GMAIL' }
  ];

  form: PlaybookInput = this.emptyForm();

  constructor(
    private playbooksService: PlaybooksService,
    private leadGroupsService: LeadGroupsService,
    private campaignsService: CampaignsService,
    private sendingService: SendingService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    this.load();
    this.loadGroups();
    this.loadCampaigns();
    this.loadInboxes();
  }

  private emptyForm(): PlaybookInput {
    return {
      name: '',
      scope: this.workspaceGroupId ? 'GROUP' : 'GLOBAL',
      groupId: this.workspaceGroupId || null,
      campaignId: null,
      leadStatus: null,
      channel: 'ALL',
      instructions: '',
      isActive: true,
      priority: 0,
      identityName: '',
      identityOrgName: '',
      identityTitle: '',
      identityEmail: '',
      identitySignature: '',
      identityPostalAddress: '',
      emailTransport: 'MAILGUN',
      gmailAccountId: null
    };
  }

  loadInboxes(): void {
    this.sendingService.loadGmail().subscribe({
      next: res => this.inboxes.set(res.accounts),
      // Silent: a playbook is still perfectly editable without this, and an
      // error toast here would fire on every visit for orgs that never intend
      // to connect an inbox.
      error: () => this.inboxes.set([])
    });
  }

  /** Inboxes offered in the picker, with their state spelled out. */
  inboxOptions(): SelectOption[] {
    return this.inboxes().map(account => ({
      value: account.id,
      label:
        account.status === 'CONNECTED'
          ? account.emailAddress
          : `${account.emailAddress} (${account.status.toLowerCase()})`
    }));
  }

  onTransportChange(): void {
    if (this.form.emailTransport !== 'GMAIL') {
      this.form.gmailAccountId = null;
      return;
    }
    // One inbox is not a choice — pick it, so the field can't be left empty in
    // the only case where empty would still have worked.
    const only = this.inboxes();
    if (only.length === 1 && !this.form.gmailAccountId) {
      this.form.gmailAccountId = only[0].id;
    }
  }

  load(): void {
    this.loading.set(true);
    this.playbooksService.list(this.workspaceGroupId || undefined).subscribe({
      next: (playbooks) => {
        this.playbooks.set(playbooks);
        // Drop ticks for playbooks that no longer exist, so a stale id can't
        // sit in the selection and inflate the next "N selected" count.
        const live = new Set(playbooks.map((p) => p.id));
        this.selectedIds.update((current) => new Set([...current].filter((id) => live.has(id))));
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  loadGroups(): void {
    this.leadGroupsService.list().subscribe({
      next: (res) => {
        this.groupOptions = res.groups.map(group => ({ label: group.name, value: group.id }));
      }
    });
  }

  loadCampaigns(): void {
    this.campaignsService.list().subscribe({
      next: (campaigns) => {
        this.campaignOptions = campaigns.map(campaign => ({ label: campaign.name, value: campaign.id }));
      }
    });
  }

  openCreate(): void {
    this.editingPlaybook = null;
    this.form = this.emptyForm();
    this.showIdentity.set(false);
    this.showDialog.set(true);
  }

  openEdit(playbook: Playbook): void {
    this.editingPlaybook = playbook;
    this.form = {
      name: playbook.name,
      scope: playbook.scope,
      groupId: playbook.groupId ?? null,
      campaignId: playbook.campaignId ?? null,
      leadStatus: playbook.leadStatus ?? null,
      channel: playbook.channel,
      instructions: playbook.instructions,
      isActive: playbook.isActive,
      priority: playbook.priority,
      identityName: playbook.identityName ?? '',
      identityOrgName: playbook.identityOrgName ?? '',
      identityTitle: playbook.identityTitle ?? '',
      identityEmail: playbook.identityEmail ?? '',
      identitySignature: playbook.identitySignature ?? '',
      identityPostalAddress: playbook.identityPostalAddress ?? '',
      emailTransport: playbook.emailTransport ?? 'MAILGUN',
      gmailAccountId: playbook.gmailAccountId ?? null
    };
    this.showIdentity.set(hasIdentity(playbook));
    this.showDialog.set(true);
  }

  /** One-line "who this sends as", or null when it inherits the organization. */
  identitySummary(playbook: Playbook): string | null {
    if (!hasIdentity(playbook)) return null;
    const who = playbook.identityName?.trim();
    const brand = playbook.identityOrgName?.trim();
    const title = playbook.identityTitle?.trim();
    if (who && brand) return title ? `${who}, ${title} at ${brand}` : `${who} at ${brand}`;
    if (who) return title ? `${who}, ${title}` : who;
    if (brand) return brand;
    if (playbook.identityEmail) return playbook.identityEmail;
    return 'Custom sign-off';
  }

  // --- Multi-select ------------------------------------------------------

  isSelected(playbook: Playbook): boolean {
    return this.selectedIds().has(playbook.id);
  }

  toggleSelected(playbook: Playbook, checked: boolean): void {
    this.selectedIds.update((current) => {
      const next = new Set(current);
      if (checked) next.add(playbook.id);
      else next.delete(playbook.id);
      return next;
    });
  }

  allSelected(): boolean {
    const list = this.playbooks();
    return list.length > 0 && list.every((p) => this.selectedIds().has(p.id));
  }

  toggleAll(checked: boolean): void {
    this.selectedIds.set(checked ? new Set(this.playbooks().map((p) => p.id)) : new Set<string>());
  }

  clearSelection(): void {
    this.selectedIds.set(new Set<string>());
  }

  /** Playbooks currently ticked, in the order they appear on screen. */
  selectedPlaybooks(): Playbook[] {
    return this.playbooks().filter((p) => this.selectedIds().has(p.id));
  }

  /**
   * Delete every ticked playbook. The confirm names them and says what happens
   * to their Engine conversations — those survive, unfiled — because "delete 9
   * playbooks?" alone doesn't tell you whether you are also about to lose the
   * record of the work done under them.
   */
  deleteSelected(): void {
    const targets = this.selectedPlaybooks();
    if (targets.length === 0 || this.bulkDeleting()) return;

    const names = targets.map((p) => `• ${p.name}`).join('\n');
    const chats = targets.reduce((sum, p) => sum + this.chatCount(p), 0);
    const chatNote = chats
      ? `\n\n${chats} Engine conversation${chats === 1 ? '' : 's'} filed under them will be kept, but will no longer be filed under any playbook.`
      : '';
    if (!confirm(`Delete ${targets.length} playbook${targets.length === 1 ? '' : 's'}?\n\n${names}${chatNote}\n\nThis cannot be undone.`)) {
      return;
    }

    this.bulkDeleting.set(true);
    this.playbooksService.bulkDelete(targets.map((p) => p.id)).subscribe({
      next: ({ deleted }) => {
        this.bulkDeleting.set(false);
        this.clearSelection();
        this.toast.success(`Deleted ${deleted} playbook${deleted === 1 ? '' : 's'}`);
        this.load();
      },
      error: () => {
        this.bulkDeleting.set(false);
        this.toast.error('Failed to delete the selected playbooks');
      }
    });
  }

  /** "Sends from a Gmail inbox" line for the card, or null on the default. */
  transportSummary(playbook: Playbook): string | null {
    if (playbook.emailTransport !== 'GMAIL') return null;
    const address = playbook.gmailAccount?.emailAddress;
    if (!address) return 'Sends from your connected Gmail inbox';
    return playbook.gmailAccount?.status === 'CONNECTED'
      ? `Sends from ${address}`
      : `${address} — ${playbook.gmailAccount?.status?.toLowerCase()}`;
  }

  /** Engine conversations filed under this playbook. */
  chatCount(playbook: Playbook): number {
    return playbook._count?.engineChats ?? 0;
  }

  conversationsLabel(playbook: Playbook): string {
    const count = this.chatCount(playbook);
    if (!count) return `No Engine conversations yet — open one for ${playbook.name}`;
    return `${count} Engine conversation${count === 1 ? '' : 's'} under ${playbook.name}`;
  }

  onScopeChange(): void {
    this.form.groupId = null;
    this.form.campaignId = null;
    this.form.leadStatus = null;
  }

  submit(): void {
    if (!this.form.name.trim() || !this.form.instructions.trim()) return;
    if (this.form.scope === 'GROUP' && !this.form.groupId) return;
    if (this.form.scope === 'CAMPAIGN' && !this.form.campaignId) return;
    if (this.form.scope === 'LEAD_STATUS' && !this.form.leadStatus) return;
    if (this.form.emailTransport === 'GMAIL' && !this.form.gmailAccountId && this.inboxes().length !== 1) {
      this.toast.error('Pick which Gmail inbox this playbook sends from');
      return;
    }

    this.saving.set(true);

    const payload: PlaybookInput = {
      ...this.form,
      groupId: this.form.scope === 'GROUP' ? this.form.groupId : null,
      campaignId: this.form.scope === 'CAMPAIGN' ? this.form.campaignId : null,
      leadStatus: this.form.scope === 'LEAD_STATUS' ? this.form.leadStatus : null
    };

    const request$ = this.editingPlaybook
      ? this.playbooksService.update(this.editingPlaybook.id, payload)
      : this.playbooksService.create(payload);

    request$.subscribe({
      next: () => {
        this.saving.set(false);
        this.showDialog.set(false);
        this.toast.success(this.editingPlaybook ? 'Playbook updated' : 'Playbook created');
        this.load();
      },
      error: () => {
        this.saving.set(false);
        this.toast.error('Failed to save playbook');
      }
    });
  }

  toggleActive(playbook: Playbook, isActive: boolean): void {
    const previous = this.playbooks();
    this.playbooks.set(previous.map(p => (p.id === playbook.id ? { ...p, isActive } : p)));

    this.playbooksService.update(playbook.id, { isActive }).subscribe({
      next: () => this.toast.success(isActive ? 'Playbook activated' : 'Playbook deactivated'),
      error: () => {
        this.playbooks.set(previous);
        this.toast.error('Failed to update playbook');
      }
    });
  }

  deletePlaybook(playbook?: Playbook): void {
    const target = playbook ?? this.editingPlaybook;
    if (!target) return;
    // Say what happens to the conversations filed under it — they survive,
    // unfiled — so deleting a playbook never feels like it might take the
    // record of the work done under it along with it.
    const chats = this.chatCount(target);
    const chatNote = chats
      ? ` Its ${chats} Engine conversation${chats === 1 ? '' : 's'} will be kept, but will no longer be filed under any playbook.`
      : '';
    if (!confirm(`Delete the "${target.name}" playbook?${chatNote} This cannot be undone.`)) return;

    this.saving.set(true);
    this.playbooksService.delete(target.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.showDialog.set(false);
        this.toast.success('Playbook deleted');
        this.load();
      },
      error: () => {
        this.saving.set(false);
        this.toast.error('Failed to delete playbook');
      }
    });
  }

  scopeBadgeVariant(scope: PlaybookScope): BadgeVariant {
    switch (scope) {
      case 'GLOBAL': return 'info';
      case 'GROUP': return 'purple';
      case 'CAMPAIGN': return 'warning';
      case 'LEAD_STATUS': return 'success';
    }
  }

  scopeBadgeText(playbook: Playbook): string {
    switch (playbook.scope) {
      case 'GLOBAL': return 'Global';
      case 'GROUP': return `Group: ${playbook.group?.name ?? 'Unknown group'}`;
      case 'CAMPAIGN': return `Campaign: ${playbook.campaign?.name ?? 'Unknown campaign'}`;
      case 'LEAD_STATUS': return `Status: ${playbook.leadStatus}`;
    }
  }

  transportLabel(transport: EmailTransport): string {
    return transport === 'GMAIL' ? 'Gmail inbox' : 'Sending domains';
  }

  channelBadgeVariant(channel: PlaybookChannel): BadgeVariant {
    switch (channel) {
      case 'VOICE': return 'orange';
      case 'EMAIL': return 'info';
      case 'SMS': return 'success';
      default: return 'default';
    }
  }
}
