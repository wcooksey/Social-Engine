import { Component, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/services/auth.service';
import { OrganizationService } from '../../core/services/organization.service';
import { ThemeService } from '../../core/services/theme.service';
import { ToastService } from '../../core/services/toast.service';
import { ModelsService } from '../../core/services/models.service';
import { ModelProvider } from '../../core/models/model.model';
import { SocialAccountsService } from '../../core/services/social-accounts.service';
import { SocialAccount, SocialPlatform, SocialPlatformParam } from '../../core/models/social-account.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { SwitchComponent } from '../../shared/components/switch/switch.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { ThemeToggleComponent } from '../../shared/components/theme-toggle/theme-toggle.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';
import { DialogComponent } from '../../shared/components/dialog/dialog.component';

interface Integration {
  name: string;
  description: string;
  icon: string;
}

interface ModelProviderCard {
  provider: ModelProvider;
  name: string;
  description: string;
  icon: string;
}

interface SocialPlatformCard {
  platform: SocialPlatform;
  param: SocialPlatformParam;
  name: string;
  icon: string;
}

function hourToTime(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function timeToHour(time: string): number {
  const hour = parseInt(time.split(':')[0], 10);
  return isNaN(hour) ? 0 : Math.min(23, Math.max(0, hour));
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CardComponent,
    InputComponent,
    ButtonComponent,
    SwitchComponent,
    BadgeComponent,
    ThemeToggleComponent,
    SelectComponent,
    DialogComponent
  ],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss'
})
export class SettingsComponent implements OnInit {
  currentUser = computed(() => this.authService.currentUser());

  dailySendCap = 200;
  quietHoursStart = '20:00';
  quietHoursEnd = '08:00';
  engineActive = true;
  socialAutonomy = false;
  savingGuardrails = false;
  loadingOrg = true;

  integrations: Integration[] = [
    { name: 'Email (Mailgun)', description: 'Send outbound email touches through Mailgun.', icon: 'bi-envelope' },
    { name: 'SMS (Twilio)', description: 'Send and receive SMS follow-ups via Twilio.', icon: 'bi-chat-dots' },
    { name: 'Voice (Vapi)', description: 'Place AI-driven voice calls via Vapi.', icon: 'bi-telephone' },
    { name: 'Search API', description: 'Power the Engine\'s web research for prospecting.', icon: 'bi-search' }
  ];

  modelProviders: ModelProviderCard[] = [
    { provider: 'anthropic', name: 'Anthropic (Claude)', description: 'Powers Claude models for the Engine.', icon: 'bi-stars' },
    { provider: 'openai', name: 'OpenAI', description: 'Powers GPT models for the Engine.', icon: 'bi-cpu' },
    { provider: 'google', name: 'Google Gemini', description: 'Powers Gemini models for the Engine.', icon: 'bi-google' },
    { provider: 'xai', name: 'xAI Grok', description: 'Powers Grok models for the Engine.', icon: 'bi-lightning-charge' },
    { provider: 'deepseek', name: 'DeepSeek', description: 'Powers DeepSeek models for the Engine.', icon: 'bi-search' }
  ];

  // Engine model
  loadingModels = true;
  savingEngineModel = false;
  engineModelSelection: string | null = null;

  engineModelOptions = computed<SelectOption[]>(() =>
    this.modelsService.models().map(model => ({
      label: model.configured ? `${model.label} — ${model.providerLabel}` : `${model.label} — ${model.providerLabel} (not configured)`,
      value: model.id,
      disabled: !model.configured
    }))
  );

  // Connected social accounts
  loadingSocialAccounts = true;
  socialAccounts = computed(() => this.socialAccountsService.accounts());
  encryptionConfigured = computed(() => this.socialAccountsService.encryptionConfigured());

  socialPlatforms: SocialPlatformCard[] = [
    { platform: 'LINKEDIN', param: 'linkedin', name: 'LinkedIn', icon: 'bi-linkedin' },
    { platform: 'FACEBOOK', param: 'facebook', name: 'Facebook', icon: 'bi-facebook' },
    { platform: 'INSTAGRAM', param: 'instagram', name: 'Instagram', icon: 'bi-instagram' },
    { platform: 'X', param: 'x', name: 'X', icon: 'bi-twitter-x' }
  ];

  showConnectDialog = false;
  connectTarget: SocialPlatformCard | null = null;
  connectStorageState = '';
  savingConnect = false;
  testingAccountId: string | null = null;
  disconnectingAccountId: string | null = null;

  constructor(
    private authService: AuthService,
    private organizationService: OrganizationService,
    public themeService: ThemeService,
    private toast: ToastService,
    private modelsService: ModelsService,
    private socialAccountsService: SocialAccountsService
  ) {}

  ngOnInit(): void {
    this.organizationService.getMine().subscribe({
      next: org => {
        this.dailySendCap = org.dailySendCap;
        this.quietHoursStart = hourToTime(org.quietHoursStart);
        this.quietHoursEnd = hourToTime(org.quietHoursEnd);
        this.engineActive = !org.paused;
        this.socialAutonomy = org.socialAutonomy;
        this.loadingOrg = false;
      },
      error: () => {
        this.loadingOrg = false;
        this.toast.error('Failed to load organization settings');
      }
    });

    this.modelsService.getModels().subscribe({
      next: res => {
        this.engineModelSelection = res.current;
        this.loadingModels = false;
      },
      error: () => {
        this.loadingModels = false;
        this.toast.error('Failed to load Engine models');
      }
    });

    this.loadSocialAccounts();
  }

  loadSocialAccounts(): void {
    this.loadingSocialAccounts = true;
    this.socialAccountsService.list().subscribe({
      next: () => {
        this.loadingSocialAccounts = false;
      },
      error: () => {
        this.loadingSocialAccounts = false;
        this.toast.error('Failed to load connected social accounts');
      }
    });
  }

  accountFor(platform: SocialPlatform): SocialAccount | undefined {
    return this.socialAccounts().find(a => a.platform === platform);
  }

  statusVariant(account?: SocialAccount): BadgeVariant {
    if (!account) return 'neutral';
    if (account.status === 'CONNECTED') return 'success';
    if (account.status === 'EXPIRED') return 'warning';
    return 'error';
  }

  statusLabel(account?: SocialAccount): string {
    if (!account) return 'Not connected';
    if (account.status === 'CONNECTED') return 'Connected';
    if (account.status === 'EXPIRED') return 'Expired';
    return 'Error';
  }

  relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  openConnectDialog(card: SocialPlatformCard): void {
    this.connectTarget = card;
    this.connectStorageState = '';
    this.showConnectDialog = true;
  }

  closeConnectDialog(): void {
    this.showConnectDialog = false;
    this.connectTarget = null;
  }

  submitConnect(): void {
    const target = this.connectTarget;
    if (!target || !this.connectStorageState.trim()) return;

    this.savingConnect = true;
    this.socialAccountsService.connect(target.param, this.connectStorageState.trim()).subscribe({
      next: () => {
        this.savingConnect = false;
        this.showConnectDialog = false;
        this.connectTarget = null;
        this.toast.success(`Connected ${target.name}`);
        this.loadSocialAccounts();
      },
      error: (err) => {
        this.savingConnect = false;
        const message = err?.error?.error?.message || err?.error?.message || 'Failed to connect account — check the pasted session JSON';
        this.toast.error(message);
      }
    });
  }

  testAccount(account: SocialAccount): void {
    this.testingAccountId = account.id;
    this.socialAccountsService.validate(account.id).subscribe({
      next: (res) => {
        this.testingAccountId = null;
        if (res.live) {
          this.toast.success('Session is live and working');
        } else {
          this.toast.warning('Session could not be validated — it may be expired');
        }
        this.loadSocialAccounts();
      },
      error: () => {
        this.testingAccountId = null;
        this.toast.error('Failed to test the connection');
      }
    });
  }

  disconnectAccount(account: SocialAccount): void {
    const label = account.label || this.platformName(account.platform);
    if (!confirm(`Disconnect ${label}? The Engine will no longer be able to use this session.`)) return;

    this.disconnectingAccountId = account.id;
    this.socialAccountsService.disconnect(account.id).subscribe({
      next: () => {
        this.disconnectingAccountId = null;
        this.toast.success('Account disconnected');
        this.loadSocialAccounts();
      },
      error: () => {
        this.disconnectingAccountId = null;
        this.toast.error('Failed to disconnect account');
      }
    });
  }

  platformName(platform: SocialPlatform): string {
    return this.socialPlatforms.find(p => p.platform === platform)?.name ?? platform;
  }

  isProviderConfigured(provider: ModelProvider): boolean {
    return this.modelsService.isProviderConfigured(provider);
  }

  saveEngineModel(): void {
    if (!this.engineModelSelection) return;
    const selection = this.engineModelSelection;
    const label = this.modelsService.models().find(m => m.id === selection)?.label ?? selection;

    this.savingEngineModel = true;
    this.modelsService.setModel(selection).subscribe({
      next: () => {
        this.savingEngineModel = false;
        this.toast.success(`Engine model set to ${label}`);
      },
      error: () => {
        this.savingEngineModel = false;
        this.toast.error('Failed to update the Engine model');
      }
    });
  }

  saveGuardrails(): void {
    this.savingGuardrails = true;
    this.organizationService
      .updateMine({
        dailySendCap: Number(this.dailySendCap) || 0,
        quietHoursStart: timeToHour(this.quietHoursStart),
        quietHoursEnd: timeToHour(this.quietHoursEnd)
      })
      .subscribe({
        next: () => {
          this.savingGuardrails = false;
          this.toast.success('Guardrails saved');
        },
        error: () => {
          this.savingGuardrails = false;
          this.toast.error('Failed to save guardrails');
        }
      });
  }

  toggleEngine(): void {
    const next = !this.engineActive;
    this.organizationService.updateMine({ paused: !next }).subscribe({
      next: () => {
        this.engineActive = next;
        this.toast.info(next ? 'Engine resumed' : 'Engine paused — all autonomous actions halted');
      },
      error: () => this.toast.error('Failed to update Engine state')
    });
  }

  toggleSocialAutonomy(): void {
    const next = !this.socialAutonomy;
    this.organizationService.updateMine({ socialAutonomy: next }).subscribe({
      next: () => {
        this.socialAutonomy = next;
        this.toast.info(next ? 'Autonomous social DMs enabled' : 'Social DMs will now be saved as drafts');
      },
      error: () => this.toast.error('Failed to update social autonomy')
    });
  }
}
