import { Component, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CampaignsService, CampaignInput } from '../../core/services/campaigns.service';
import { Campaign, CampaignChannel, CampaignMode } from '../../core/models/campaign.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { DialogComponent } from '../../shared/components/dialog/dialog.component';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-campaigns',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CardComponent,
    ButtonComponent,
    InputComponent,
    SelectComponent,
    BadgeComponent,
    DialogComponent
  ],
  templateUrl: './campaigns.component.html',
  styleUrl: './campaigns.component.scss'
})
export class CampaignsComponent implements OnInit {
  campaigns = signal<Campaign[]>([]);
  loading = signal(true);

  showDialog = signal(false);
  saving = signal(false);

  allChannels: CampaignChannel[] = ['EMAIL', 'SMS', 'VOICE', 'SOCIAL'];

  modeOptions: SelectOption[] = [
    { label: 'Autonomous', value: 'AUTONOMOUS' },
    { label: 'Approval Required', value: 'APPROVAL_REQUIRED' }
  ];

  form: CampaignInput = {
    name: '',
    offer: '',
    channels: [],
    mode: 'APPROVAL_REQUIRED',
    followUpCadenceDays: 3,
    maxTouches: 5
  };

  constructor(private campaignsService: CampaignsService, private toast: ToastService, private router: Router) {}

  ngOnInit(): void {
    this.load();
  }

  openCampaign(campaign: Campaign): void {
    this.router.navigate(['/campaigns', campaign.id]);
  }

  load(): void {
    this.loading.set(true);
    this.campaignsService.list().subscribe({
      next: (campaigns) => {
        this.campaigns.set(campaigns);
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  openCreate(): void {
    this.form = {
      name: '',
      offer: '',
      channels: [],
      mode: 'APPROVAL_REQUIRED',
      followUpCadenceDays: 3,
      maxTouches: 5
    };
    this.showDialog.set(true);
  }

  toggleChannel(channel: CampaignChannel): void {
    if (this.form.channels.includes(channel)) {
      this.form.channels = this.form.channels.filter(c => c !== channel);
    } else {
      this.form.channels = [...this.form.channels, channel];
    }
  }

  submit(): void {
    if (!this.form.name.trim() || !this.form.offer.trim() || this.form.channels.length === 0) return;
    this.saving.set(true);
    this.campaignsService.create(this.form).subscribe({
      next: () => {
        this.saving.set(false);
        this.showDialog.set(false);
        this.toast.success('Campaign created');
        this.load();
      },
      error: () => {
        this.saving.set(false);
        this.toast.error('Failed to create campaign');
      }
    });
  }

  channelIcon(channel: CampaignChannel): string {
    switch (channel) {
      case 'EMAIL': return 'bi-envelope';
      case 'SMS': return 'bi-chat-dots';
      case 'VOICE': return 'bi-telephone';
      case 'SOCIAL': return 'bi-share';
      default: return 'bi-circle';
    }
  }

  modeBadgeVariant(mode: CampaignMode): BadgeVariant {
    return mode === 'AUTONOMOUS' ? 'purple' : 'warning';
  }

  statusBadgeVariant(status: string): BadgeVariant {
    switch (status) {
      case 'ACTIVE': return 'success';
      case 'PAUSED': return 'warning';
      case 'COMPLETED': return 'neutral';
      default: return 'default';
    }
  }
}
