import { Component, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/services/auth.service';
import { OrganizationService } from '../../core/services/organization.service';
import { ThemeService } from '../../core/services/theme.service';
import { ToastService } from '../../core/services/toast.service';
import { ModelsService } from '../../core/services/models.service';
import { SettingsService } from '../../core/services/settings.service';
import { OrgSetting, OrgSettingGroup, PlatformSetting } from '../../core/models/settings.model';
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

interface SettingGroupView {
  group: OrgSettingGroup;
  name: string;
  icon: string;
  description: string;
  settings: OrgSetting[];
}

const GROUP_META: Record<OrgSettingGroup, { name: string; icon: string; description: string }> = {
  ai: { name: 'AI providers', icon: 'bi-stars', description: 'API keys for the models that power the Engine. Failover walks whichever providers you configure.' },
  search: { name: 'Web search', icon: 'bi-search', description: 'Powers the Engine\'s web research for prospecting and enrichment.' },
  email: { name: 'Email (Mailgun)', icon: 'bi-envelope', description: 'Send outbound email touches and receive replies through Mailgun.' },
  sms: { name: 'SMS (Twilio)', icon: 'bi-chat-dots', description: 'Send and receive SMS follow-ups via Twilio.' },
  voice: { name: 'Voice (Vapi)', icon: 'bi-telephone', description: 'Place AI-driven voice calls via Vapi.' }
};

const GROUP_ORDER: OrgSettingGroup[] = ['ai', 'search', 'email', 'sms', 'voice'];

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

  // Org integration settings (API keys, channel creds)
  loadingSettings = true;
  isSuperAdmin = computed(() => !!this.authService.currentUser()?.isSuperAdmin);
  settingEdits: Record<string, string> = {};
  savingSettingKey: string | null = null;

  settingGroups = computed<SettingGroupView[]>(() => {
    const all = this.settingsService.orgSettings();
    return GROUP_ORDER.map(group => ({
      group,
      name: GROUP_META[group].name,
      icon: GROUP_META[group].icon,
      description: GROUP_META[group].description,
      settings: all.filter(s => s.group === group)
    })).filter(g => g.settings.length > 0);
  });

  // Platform (super-admin) settings
  loadingPlatform = true;
  platformSettings = computed(() => this.settingsService.platformSettings());
  platformEdits: Record<string, string> = {};
  savingPlatformKey: string | null = null;

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
    private settingsService: SettingsService,
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
    this.loadOrgSettings();

    if (this.isSuperAdmin()) {
      this.loadPlatformSettings();
    }
  }

  loadOrgSettings(): void {
    this.loadingSettings = true;
    this.settingsService.getOrgSettings().subscribe({
      next: res => {
        // Prefill non-secret inputs with their resolved values.
        this.settingEdits = {};
        for (const s of res.settings) {
          if (!s.secret) this.settingEdits[s.key] = s.value ?? '';
        }
        this.loadingSettings = false;
      },
      error: () => {
        this.loadingSettings = false;
        this.toast.error('Failed to load integration settings');
      }
    });
  }

  loadPlatformSettings(): void {
    this.loadingPlatform = true;
    this.settingsService.getPlatformSettings().subscribe({
      next: res => {
        this.platformEdits = {};
        for (const s of res.settings) this.platformEdits[s.key] = String(s.value);
        this.loadingPlatform = false;
      },
      error: () => {
        this.loadingPlatform = false;
        this.toast.error('Failed to load platform settings');
      }
    });
  }

  saveSetting(setting: OrgSetting): void {
    const value = (this.settingEdits[setting.key] ?? '').trim();
    // For secrets, an empty box means "leave unchanged" — nothing to save.
    if (setting.secret && value === '') return;

    this.savingSettingKey = setting.key;
    this.settingsService.setOrgSetting(setting.key, value).subscribe({
      next: res => {
        this.savingSettingKey = null;
        // Clear the secret input after a successful save; refresh non-secrets.
        for (const s of res.settings) {
          if (s.secret) {
            this.settingEdits[s.key] = '';
          } else if (this.settingEdits[s.key] === undefined) {
            this.settingEdits[s.key] = s.value ?? '';
          }
        }
        this.toast.success(`${setting.label} saved`);
        // Keep the models catalog in sync when an AI key changes.
        if (setting.group === 'ai') this.modelsService.getModels().subscribe();
      },
      error: (err) => {
        this.savingSettingKey = null;
        const message = err?.error?.error?.message || err?.error?.message || `Failed to save ${setting.label}`;
        this.toast.error(message);
      }
    });
  }

  clearSetting(setting: OrgSetting): void {
    this.savingSettingKey = setting.key;
    this.settingsService.setOrgSetting(setting.key, '').subscribe({
      next: () => {
        this.savingSettingKey = null;
        this.settingEdits[setting.key] = '';
        this.toast.info(`${setting.label} cleared`);
        if (setting.group === 'ai') this.modelsService.getModels().subscribe();
      },
      error: () => {
        this.savingSettingKey = null;
        this.toast.error(`Failed to clear ${setting.label}`);
      }
    });
  }

  savePlatformSetting(setting: PlatformSetting): void {
    const value = this.platformEdits[setting.key];
    if (value === null || value === undefined || value === '' || isNaN(Number(value))) {
      this.toast.error(`${setting.label} must be a number`);
      return;
    }
    this.savingPlatformKey = setting.key;
    this.settingsService.setPlatformSetting(setting.key, Number(value)).subscribe({
      next: () => {
        this.savingPlatformKey = null;
        this.toast.success(`${setting.label} saved`);
      },
      error: (err) => {
        this.savingPlatformKey = null;
        const message = err?.error?.error?.message || err?.error?.message || `Failed to save ${setting.label}`;
        this.toast.error(message);
      }
    });
  }

  settingStatusVariant(setting: OrgSetting): BadgeVariant {
    if (setting.source === 'org') return 'success';
    if (setting.source === 'env') return 'info';
    return 'neutral';
  }

  settingStatusLabel(setting: OrgSetting): string {
    if (setting.source === 'org') return 'Set';
    if (setting.source === 'env') return 'From env';
    return 'Not set';
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
