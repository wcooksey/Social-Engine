import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PlaybooksService, PlaybookInput } from '../../core/services/playbooks.service';
import { Playbook, PlaybookChannel, PlaybookScope } from '../../core/models/playbook.model';
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
  playbooks = signal<Playbook[]>([]);
  loading = signal(true);

  showDialog = signal(false);
  saving = signal(false);
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

  form: PlaybookInput = this.emptyForm();

  constructor(
    private playbooksService: PlaybooksService,
    private leadGroupsService: LeadGroupsService,
    private campaignsService: CampaignsService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    this.load();
    this.loadGroups();
    this.loadCampaigns();
  }

  private emptyForm(): PlaybookInput {
    return {
      name: '',
      scope: 'GLOBAL',
      groupId: null,
      campaignId: null,
      leadStatus: null,
      channel: 'ALL',
      instructions: '',
      isActive: true,
      priority: 0
    };
  }

  load(): void {
    this.loading.set(true);
    this.playbooksService.list().subscribe({
      next: (playbooks) => {
        this.playbooks.set(playbooks);
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  loadGroups(): void {
    this.leadGroupsService.list().subscribe({
      next: (groups) => {
        this.groupOptions = groups.map(group => ({ label: group.name, value: group.id }));
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
      priority: playbook.priority
    };
    this.showDialog.set(true);
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
    if (!confirm(`Delete the "${target.name}" playbook? This cannot be undone.`)) return;

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

  channelBadgeVariant(channel: PlaybookChannel): BadgeVariant {
    switch (channel) {
      case 'VOICE': return 'orange';
      case 'EMAIL': return 'info';
      case 'SMS': return 'success';
      default: return 'default';
    }
  }
}
