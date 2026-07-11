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

  // Email notifications
  notifyByEmail = true;
  savingNotifyByEmail = false;

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
    this.loadBookingLinks();
    this.loadTestStatus();

    // Prefill the test-email box with the signed-in user's address.
    this.testEmailTo = this.authService.currentUser()?.email ?? '';

    // Seed the notifications toggle from the cached user, then refresh from /me.
    this.notifyByEmail = this.authService.currentUser()?.notifyByEmail ?? true;
    this.authService.me().subscribe({
      next: user => { this.notifyByEmail = user.notifyByEmail ?? true; },
      error: () => {}
    });

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
