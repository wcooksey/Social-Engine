import { Component, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { OrganizationService } from '../../core/services/organization.service';
import { ThemeService } from '../../core/services/theme.service';
import { ToastService } from '../../core/services/toast.service';
import { ModelsService } from '../../core/services/models.service';
import { SettingsService } from '../../core/services/settings.service';
import { OrgSetting, OrgSettingGroup } from '../../core/models/settings.model';
import { SocialAccountsService } from '../../core/services/social-accounts.service';
import { SocialAccount, SocialPlatform, SocialPlatformParam } from '../../core/models/social-account.model';
import { BookingLinksService } from '../../core/services/booking-links.service';
import { Availability, BookingLink, BookingLinkInput } from '../../core/models/booking-link.model';
import { LeadsService, ImportResult } from '../../core/services/leads.service';
import { TestBenchService, TestChannelStatus } from '../../core/services/test-bench.service';
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
  voice: { name: 'Voice', icon: 'bi-telephone', description: 'Vapi places AI phone calls to leads; ElevenLabs powers the Engine\'s live voice conversation mode.' }
};

const GROUP_ORDER: OrgSettingGroup[] = ['ai', 'search', 'email', 'sms', 'voice'];

interface SocialPlatformCard {
  platform: SocialPlatform;
  param: SocialPlatformParam;
  name: string;
  icon: string;
  /** Exact login page for this platform, so the copied command needs no editing. */
  loginUrl: string;
}

function hourToTime(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function timeToHour(time: string): number {
  const hour = parseInt(time.split(':')[0], 10);
  return isNaN(hour) ? 0 : Math.min(23, Math.max(0, hour));
}

// Booking-link availability editor: one editable window per ISO weekday (1=Mon..7=Sun).
interface DayAvailabilityRow {
  weekday: string;
  label: string;
  enabled: boolean;
  start: string;
  end: string;
}

interface BookingLinkForm {
  title: string;
  description: string;
  durationMinutes: number;
  bufferMinutes: number;
  timezone: string;
}

const WEEKDAYS: { weekday: string; label: string }[] = [
  { weekday: '1', label: 'Mon' },
  { weekday: '2', label: 'Tue' },
  { weekday: '3', label: 'Wed' },
  { weekday: '4', label: 'Thu' },
  { weekday: '5', label: 'Fri' },
  { weekday: '6', label: 'Sat' },
  { weekday: '7', label: 'Sun' }
];

function defaultAvailabilityRows(): DayAvailabilityRow[] {
  return WEEKDAYS.map(d => ({
    weekday: d.weekday,
    label: d.label,
    enabled: d.weekday !== '6' && d.weekday !== '7',
    start: '09:00',
    end: '17:00'
  }));
}

function rowsFromAvailability(availability: Availability): DayAvailabilityRow[] {
  return WEEKDAYS.map(d => {
    const windows = availability?.[d.weekday];
    const first = windows && windows.length ? windows[0] : null;
    return {
      weekday: d.weekday,
      label: d.label,
      enabled: !!first,
      start: first ? first[0] : '09:00',
      end: first ? first[1] : '17:00'
    };
  });
}

function availabilityFromRows(rows: DayAvailabilityRow[]): Availability {
  const availability: Availability = {};
  for (const row of rows) {
    if (row.enabled) {
      availability[row.weekday] = [[row.start, row.end]];
    }
  }
  return availability;
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
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

  // Engine model
  loadingModels = true;
  savingEngineModel = false;
  engineModelSelection: string | null = null;

  engineModelOptions = computed<SelectOption[]>(() =>
    this.modelsService.modelOptionsWithCurrent().map(model => ({
      label: model.configured ? `${model.label} — ${model.providerLabel}` : `${model.label} — ${model.providerLabel} (needs API key)`,
      value: model.id,
      // Selectable even without a key — the user gets told to add it. Blocking
      // selection dead-ends anyone whose current model was removed/unconfigured.
      disabled: false
    }))
  );

  // Connected social accounts
  loadingSocialAccounts = true;
  socialAccounts = computed(() => this.socialAccountsService.accounts());
  encryptionConfigured = computed(() => this.socialAccountsService.encryptionConfigured());

  socialPlatforms: SocialPlatformCard[] = [
    { platform: 'LINKEDIN', param: 'linkedin', name: 'LinkedIn', icon: 'bi-linkedin', loginUrl: 'https://www.linkedin.com/login' },
    { platform: 'FACEBOOK', param: 'facebook', name: 'Facebook', icon: 'bi-facebook', loginUrl: 'https://www.facebook.com/login' },
    { platform: 'INSTAGRAM', param: 'instagram', name: 'Instagram', icon: 'bi-instagram', loginUrl: 'https://www.instagram.com/accounts/login/' },
    { platform: 'X', param: 'x', name: 'X', icon: 'bi-twitter-x', loginUrl: 'https://x.com/login' }
  ];

  showConnectDialog = false;
  connectTarget: SocialPlatformCard | null = null;
  connectStorageState = '';
  savingConnect = false;
  testingAccountId: string | null = null;
  disconnectingAccountId: string | null = null;
  /** Last failed session check, explained — a toast is too short for the fix. */
  sessionIssue: string | null = null;
  sessionIssueReason: string | null = null;

  // Email notifications
  notifyByEmail = true;
  savingNotifyByEmail = false;

  // Profile. Changing the email rotates the login identity, so the server asks
  // for the current password and hands back fresh tokens.
  profileForm = { firstName: '', lastName: '', email: '' };
  profilePassword = '';
  savingProfile = false;

  // Password change
  passwordForm = { current: '', next: '', confirm: '' };
  savingPassword = false;

  // Organization name (guardrails below have their own save button)
  orgName = '';
  savingOrgName = false;

  // Booking links
  bookingLinks: BookingLink[] = [];
  loadingBookingLinks = true;
  showBookingDialog = false;
  editingBookingLink: BookingLink | null = null;
  savingBookingLink = false;
  togglingBookingLinkId: string | null = null;
  deletingBookingLinkId: string | null = null;
  copiedBookingLinkId: string | null = null;
  bookingForm: BookingLinkForm = { title: '', description: '', durationMinutes: 30, bufferMinutes: 0, timezone: '' };
  bookingAvailability: DayAvailabilityRow[] = defaultAvailabilityRows();

  // CSV lead import
  csvText = '';
  csvGroupName = '';
  csvFileName = '';
  importingCsv = false;
  importResult: ImportResult | null = null;

  // Test channels (send to yourself)
  loadingTestStatus = true;
  testStatus: TestChannelStatus | null = null;
  testEmailTo = '';
  testPhoneTo = '';
  testDmPlatform: string | null = null;
  testDmProfileUrl = '';
  testDmMessage = '';
  sendingTestEmail = false;
  sendingTestSms = false;
  placingTestCall = false;
  sendingTestDm = false;

  constructor(
    private authService: AuthService,
    private organizationService: OrganizationService,
    public themeService: ThemeService,
    private toast: ToastService,
    private modelsService: ModelsService,
    private settingsService: SettingsService,
    private socialAccountsService: SocialAccountsService,
    private bookingLinksService: BookingLinksService,
    private leadsService: LeadsService,
    private testBenchService: TestBenchService
  ) {}

  ngOnInit(): void {
    this.resetProfileForm();

    this.organizationService.getMine().subscribe({
      next: org => {
        this.orgName = org.name;
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
    this.loadBookingLinks();
    this.loadTestStatus();

    // Prefill the test-email box with the signed-in user's address.
    this.testEmailTo = this.authService.currentUser()?.email ?? '';

    // Seed the notifications toggle from the cached user, then refresh from /me.
    this.notifyByEmail = this.authService.currentUser()?.notifyByEmail ?? true;
    this.authService.me().subscribe({
      next: user => {
        this.notifyByEmail = user.notifyByEmail ?? true;
        this.resetProfileForm();
      },
      error: () => {}
    });
  }

  // --- Profile -------------------------------------------------------------

  private resetProfileForm(): void {
    const user = this.authService.currentUser();
    this.profileForm = {
      firstName: user?.firstName ?? '',
      lastName: user?.lastName ?? '',
      email: user?.email ?? ''
    };
    this.profilePassword = '';
  }

  /** True once the email box differs from the signed-in address. */
  get emailChanged(): boolean {
    const current = (this.authService.currentUser()?.email ?? '').toLowerCase();
    return this.profileForm.email.trim().toLowerCase() !== current;
  }

  get profileDirty(): boolean {
    const user = this.authService.currentUser();
    return (
      this.profileForm.firstName.trim() !== (user?.firstName ?? '') ||
      this.profileForm.lastName.trim() !== (user?.lastName ?? '') ||
      this.emailChanged
    );
  }

  saveProfile(): void {
    if (!this.profileForm.firstName.trim()) {
      this.toast.error('First name cannot be empty');
      return;
    }
    if (this.emailChanged && !this.profilePassword) {
      this.toast.error('Enter your current password to change your email address');
      return;
    }

    this.savingProfile = true;
    this.authService
      .updateProfile({
        firstName: this.profileForm.firstName.trim(),
        lastName: this.profileForm.lastName.trim(),
        email: this.profileForm.email.trim(),
        ...(this.emailChanged ? { currentPassword: this.profilePassword } : {})
      })
      .subscribe({
        next: () => {
          this.savingProfile = false;
          this.profilePassword = '';
          this.resetProfileForm();
          this.toast.success('Profile updated');
        },
        error: err => {
          this.savingProfile = false;
          this.toast.error(this.errorMessage(err, 'Failed to update your profile'));
        }
      });
  }

  changePassword(): void {
    if (this.passwordForm.next !== this.passwordForm.confirm) {
      this.toast.error('New passwords do not match');
      return;
    }
    if (this.passwordForm.next.length < 8) {
      this.toast.error('New password must be at least 8 characters');
      return;
    }

    this.savingPassword = true;
    this.authService.changePassword(this.passwordForm.current, this.passwordForm.next).subscribe({
      next: () => {
        this.savingPassword = false;
        this.passwordForm = { current: '', next: '', confirm: '' };
        this.toast.success('Password changed — other devices have been signed out');
      },
      error: err => {
        this.savingPassword = false;
        this.toast.error(this.errorMessage(err, 'Failed to change your password'));
      }
    });
  }

  saveOrgName(): void {
    const name = this.orgName.trim();
    if (!name) {
      this.toast.error('Organization name cannot be empty');
      return;
    }

    this.savingOrgName = true;
    this.organizationService.updateMine({ name }).subscribe({
      next: () => {
        this.savingOrgName = false;
        // The name is part of the cached user payload the header reads from.
        this.authService.me().subscribe();
        this.toast.success('Organization name updated');
      },
      error: err => {
        this.savingOrgName = false;
        this.toast.error(this.errorMessage(err, 'Failed to update the organization name'));
      }
    });
  }

  /** Pull the server's message out of an HttpErrorResponse, or fall back. */
  private errorMessage(err: unknown, fallback: string): string {
    const e = err as { error?: { error?: { message?: string } | string; message?: string } };
    const inner = e?.error?.error;
    if (typeof inner === 'string') return inner;
    return inner?.message || e?.error?.message || fallback;
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

  // --- Guided session capture --------------------------------------------
  // Capturing a login session means running a terminal command, which is the
  // one genuinely technical step in setup. Rather than a paragraph telling
  // people to "swap the URL", each platform gets the exact command, per OS,
  // with copy buttons — so it's paste-and-go with nothing to edit.

  /** Windows uses a different terminal app and a different "print file" command. */
  captureOs: 'mac' | 'windows' = /win/i.test(navigator.platform || navigator.userAgent) ? 'windows' : 'mac';
  copiedCommand: string | null = null;

  get captureTerminalName(): string {
    return this.captureOs === 'windows' ? 'PowerShell' : 'Terminal';
  }

  get captureTerminalHint(): string {
    return this.captureOs === 'windows'
      ? 'Press the Windows key, type "PowerShell", and open it.'
      : 'Press ⌘ + Space, type "Terminal", and press Enter.';
  }

  /** The one command that captures the session for the platform being connected. */
  get captureCommand(): string {
    const url = this.connectTarget?.loginUrl ?? 'https://www.instagram.com/accounts/login/';
    return `npx playwright@latest codegen --save-storage=session.json ${url}`;
  }

  /** Prints the saved file so it can be copied straight out of the terminal. */
  get printFileCommand(): string {
    return this.captureOs === 'windows' ? 'type session.json' : 'cat session.json';
  }

  copyCommand(command: string): void {
    if (!navigator.clipboard) {
      this.toast.warning('Copying is blocked in this browser — select the text and copy manually');
      return;
    }
    navigator.clipboard.writeText(command).then(
      () => {
        this.copiedCommand = command;
        this.toast.success('Command copied');
        setTimeout(() => {
          if (this.copiedCommand === command) this.copiedCommand = null;
        }, 2500);
      },
      () => this.toast.error('Could not copy — select the text and copy manually')
    );
  }

  openConnectDialog(card: SocialPlatformCard): void {
    this.connectTarget = card;
    this.connectStorageState = '';
    this.copiedCommand = null;
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
    this.sessionIssue = null;
    this.sessionIssueReason = null;
    this.socialAccountsService.validate(account.id).subscribe({
      next: (res) => {
        this.testingAccountId = null;
        if (res.live) {
          this.toast.success('Session is live and working');
        } else {
          // Show what actually happened. "May be expired" was a guess, and the
          // wrong one for a checkpoint — where re-capturing can never work.
          this.sessionIssue = res.detail || 'Session could not be validated.';
          this.sessionIssueReason = res.reason ?? null;
          this.toast.warning(
            res.reason === 'checkpoint'
              ? 'Login challenged by the platform — approve it on your device (details below)'
              : res.detail || 'Session could not be validated — it may be expired'
          );
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

  // --- Email notifications ---

  toggleNotifyByEmail(): void {
    const next = !this.notifyByEmail;
    this.savingNotifyByEmail = true;
    this.authService.updateNotifications(next).subscribe({
      next: user => {
        this.savingNotifyByEmail = false;
        this.notifyByEmail = user.notifyByEmail ?? next;
        this.toast.success(next ? 'Email alerts enabled' : 'Email alerts disabled');
      },
      error: () => {
        this.savingNotifyByEmail = false;
        this.toast.error('Failed to update notification preference');
      }
    });
  }

  // --- Booking links ---

  private defaultTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }

  loadBookingLinks(): void {
    this.loadingBookingLinks = true;
    this.bookingLinksService.list().subscribe({
      next: links => {
        this.bookingLinks = links;
        this.loadingBookingLinks = false;
      },
      error: () => {
        this.loadingBookingLinks = false;
        this.toast.error('Failed to load booking links');
      }
    });
  }

  availabilitySummary(link: BookingLink): string {
    const days = WEEKDAYS.filter(d => (link.availability?.[d.weekday]?.length ?? 0) > 0).map(d => d.label);
    return days.length ? days.join(', ') : 'No availability set';
  }

  openCreateBookingLink(): void {
    this.editingBookingLink = null;
    this.bookingForm = { title: '', description: '', durationMinutes: 30, bufferMinutes: 0, timezone: this.defaultTimezone() };
    this.bookingAvailability = defaultAvailabilityRows();
    this.showBookingDialog = true;
  }

  openEditBookingLink(link: BookingLink): void {
    this.editingBookingLink = link;
    this.bookingForm = {
      title: link.title,
      description: link.description ?? '',
      durationMinutes: link.durationMinutes,
      bufferMinutes: link.bufferMinutes,
      timezone: link.timezone
    };
    this.bookingAvailability = rowsFromAvailability(link.availability || {});
    this.showBookingDialog = true;
  }

  closeBookingDialog(): void {
    this.showBookingDialog = false;
    this.editingBookingLink = null;
  }

  saveBookingLink(): void {
    const title = this.bookingForm.title.trim();
    if (!title) {
      this.toast.error('Title is required');
      return;
    }

    const payload: BookingLinkInput = {
      title,
      description: this.bookingForm.description.trim(),
      durationMinutes: Number(this.bookingForm.durationMinutes) || 30,
      bufferMinutes: Number(this.bookingForm.bufferMinutes) || 0,
      timezone: this.bookingForm.timezone.trim() || this.defaultTimezone(),
      availability: availabilityFromRows(this.bookingAvailability)
    };

    this.savingBookingLink = true;
    const editing = this.editingBookingLink;
    const request = editing
      ? this.bookingLinksService.update(editing.id, payload)
      : this.bookingLinksService.create(payload);

    request.subscribe({
      next: () => {
        this.savingBookingLink = false;
        this.showBookingDialog = false;
        this.editingBookingLink = null;
        this.toast.success(editing ? 'Booking link updated' : 'Booking link created');
        this.loadBookingLinks();
      },
      error: (err) => {
        this.savingBookingLink = false;
        const message = err?.error?.error?.message || err?.error?.message || 'Failed to save booking link';
        this.toast.error(message);
      }
    });
  }

  toggleBookingLinkActive(link: BookingLink): void {
    const next = !link.active;
    this.togglingBookingLinkId = link.id;
    this.bookingLinksService.update(link.id, { active: next }).subscribe({
      next: updated => {
        this.togglingBookingLinkId = null;
        link.active = updated.active;
        this.toast.info(next ? 'Booking link activated' : 'Booking link paused');
      },
      error: (err) => {
        this.togglingBookingLinkId = null;
        const message = err?.error?.error?.message || err?.error?.message || 'Failed to update booking link';
        this.toast.error(message);
      }
    });
  }

  copyBookingLink(link: BookingLink): void {
    if (!navigator.clipboard) {
      this.toast.error('Clipboard is not available in this browser');
      return;
    }
    navigator.clipboard.writeText(link.url).then(
      () => {
        this.copiedBookingLinkId = link.id;
        this.toast.success('Link copied to clipboard');
        setTimeout(() => {
          if (this.copiedBookingLinkId === link.id) this.copiedBookingLinkId = null;
        }, 2000);
      },
      () => this.toast.error('Failed to copy link')
    );
  }

  deleteBookingLink(link: BookingLink): void {
    if (!confirm(`Delete "${link.title}"? The public link will stop working immediately.`)) return;

    this.deletingBookingLinkId = link.id;
    this.bookingLinksService.delete(link.id).subscribe({
      next: () => {
        this.deletingBookingLinkId = null;
        this.bookingLinks = this.bookingLinks.filter(l => l.id !== link.id);
        this.toast.success('Booking link deleted');
      },
      error: (err) => {
        this.deletingBookingLinkId = null;
        const message = err?.error?.error?.message || err?.error?.message || 'Failed to delete booking link';
        this.toast.error(message);
      }
    });
  }

  // --- CSV lead import ---

  onCsvFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) return;
    this.csvFileName = file.name;
    const reader = new FileReader();
    reader.onload = () => { this.csvText = String(reader.result ?? ''); };
    reader.onerror = () => this.toast.error('Failed to read the file');
    reader.readAsText(file);
  }

  importCsv(): void {
    const csv = this.csvText.trim();
    if (!csv) {
      this.toast.error('Paste CSV text or choose a .csv file first');
      return;
    }
    this.importingCsv = true;
    this.importResult = null;
    this.leadsService.importLeads(csv, this.csvGroupName.trim() || undefined).subscribe({
      next: res => {
        this.importingCsv = false;
        this.importResult = res;
        this.toast.success(`Imported ${res.created} new, ${res.updated} updated`);
      },
      error: (err) => {
        this.importingCsv = false;
        const message = err?.error?.error?.message || err?.error?.message || 'Failed to import leads';
        this.toast.error(message);
      }
    });
  }

  // --- Test channels (send to yourself) ---

  private testError(err: any, fallback: string): string {
    return err?.error?.error || err?.error?.message || fallback;
  }

  loadTestStatus(): void {
    this.loadingTestStatus = true;
    this.testBenchService.status().subscribe({
      next: status => {
        this.testStatus = status;
        // Default the DM platform picker to the first connected platform.
        if (status.socialPlatforms.length > 0 && !this.testDmPlatform) {
          this.testDmPlatform = status.socialPlatforms[0];
        }
        this.loadingTestStatus = false;
      },
      error: (err) => {
        this.loadingTestStatus = false;
        this.toast.error(this.testError(err, 'Failed to load test channel status'));
      }
    });
  }

  testDmPlatformOptions(): SelectOption[] {
    return (this.testStatus?.socialPlatforms ?? []).map(p => ({
      label: p.charAt(0).toUpperCase() + p.slice(1),
      value: p
    }));
  }

  sendTestEmail(): void {
    const to = this.testEmailTo.trim();
    if (!to) {
      this.toast.error('Enter an email address first');
      return;
    }
    this.sendingTestEmail = true;
    this.testBenchService.sendEmail(to).subscribe({
      next: res => {
        this.sendingTestEmail = false;
        this.toast.success(`Test email sent to ${res.to} — check your inbox.`);
      },
      error: (err) => {
        this.sendingTestEmail = false;
        this.toast.error(this.testError(err, 'Failed to send test email'));
      }
    });
  }

  sendTestSms(): void {
    const to = this.testPhoneTo.trim();
    if (!to) {
      this.toast.error('Enter a phone number first');
      return;
    }
    this.sendingTestSms = true;
    this.testBenchService.sendSms(to).subscribe({
      next: res => {
        this.sendingTestSms = false;
        this.toast.success(`Test SMS sent to ${res.to}.`);
      },
      error: (err) => {
        this.sendingTestSms = false;
        this.toast.error(this.testError(err, 'Failed to send test SMS'));
      }
    });
  }

  placeTestCall(): void {
    const to = this.testPhoneTo.trim();
    if (!to) {
      this.toast.error('Enter a phone number first');
      return;
    }
    this.placingTestCall = true;
    this.testBenchService.placeCall(to).subscribe({
      next: res => {
        this.placingTestCall = false;
        this.toast.success(`Test call placed to ${res.to} — your phone should ring.`);
      },
      error: (err) => {
        this.placingTestCall = false;
        this.toast.error(this.testError(err, 'Failed to place test call'));
      }
    });
  }

  sendTestDm(): void {
    const platform = this.testDmPlatform;
    const profileUrl = this.testDmProfileUrl.trim();
    if (!platform) {
      this.toast.error('Choose a platform first');
      return;
    }
    if (!profileUrl) {
      this.toast.error('Enter a profile URL first');
      return;
    }
    this.sendingTestDm = true;
    const message = this.testDmMessage.trim();
    this.testBenchService.sendDm(platform, profileUrl, message || undefined).subscribe({
      next: res => {
        this.sendingTestDm = false;
        this.toast.success(res.note);
      },
      error: (err) => {
        this.sendingTestDm = false;
        this.toast.error(this.testError(err, 'Failed to send test DM'));
      }
    });
  }
}
