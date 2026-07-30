import { Component, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminService } from '../../core/services/admin.service';
import { AdminOrganization, AdminOverview, AdminUser } from '../../core/models/admin.model';
import { SettingsService } from '../../core/services/settings.service';
import { PlatformSetting } from '../../core/models/settings.model';
import { ToastService } from '../../core/services/toast.service';
import { CardComponent } from '../../shared/components/card/card.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { SwitchComponent } from '../../shared/components/switch/switch.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';

type AdminTab = 'organizations' | 'users' | 'platform';

const ROLE_OPTIONS: SelectOption[] = [
  { label: 'Owner', value: 'OWNER' },
  { label: 'Admin', value: 'ADMIN' },
  { label: 'Member', value: 'MEMBER' }
];

/**
 * Deployment-wide operator console for the super-admin account: who is on the
 * platform, what they're spending, and the safety levers. Intentionally has no
 * way to read another tenant's leads, keys, or conversations — pausing an org
 * and suspending an account is as far as it goes.
 */
@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CardComponent,
    ButtonComponent,
    InputComponent,
    BadgeComponent,
    SwitchComponent,
    SelectComponent
  ],
  templateUrl: './admin.component.html',
  styleUrl: './admin.component.scss'
})
export class AdminComponent implements OnInit {
  tab = signal<AdminTab>('organizations');

  overview = signal<AdminOverview | null>(null);
  loadingOverview = true;

  organizations = signal<AdminOrganization[]>([]);
  loadingOrgs = true;
  capEdits: Record<string, string> = {};
  savingOrgId: string | null = null;

  users = signal<AdminUser[]>([]);
  loadingUsers = true;
  userSearch = '';
  savingUserId: string | null = null;
  roleOptions = ROLE_OPTIONS;

  platformSettings = computed(() => this.settingsService.platformSettings());
  loadingPlatform = true;
  platformEdits: Record<string, string> = {};
  savingPlatformKey: string | null = null;

  constructor(
    private adminService: AdminService,
    private settingsService: SettingsService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    this.loadOverview();
    this.loadOrganizations();
    this.loadUsers();
    this.loadPlatformSettings();
  }

  loadOverview(): void {
    this.loadingOverview = true;
    this.adminService.overview().subscribe({
      next: data => {
        this.overview.set(data);
        this.loadingOverview = false;
      },
      error: () => {
        this.loadingOverview = false;
        this.toast.error('Failed to load platform overview');
      }
    });
  }

  loadOrganizations(): void {
    this.loadingOrgs = true;
    this.adminService.organizations().subscribe({
      next: orgs => {
        this.organizations.set(orgs);
        this.capEdits = {};
        for (const o of orgs) this.capEdits[o.id] = String(o.dailySendCap);
        this.loadingOrgs = false;
      },
      error: () => {
        this.loadingOrgs = false;
        this.toast.error('Failed to load organizations');
      }
    });
  }

  loadUsers(): void {
    this.loadingUsers = true;
    this.adminService.users(this.userSearch.trim()).subscribe({
      next: users => {
        this.users.set(users);
        this.loadingUsers = false;
      },
      error: () => {
        this.loadingUsers = false;
        this.toast.error('Failed to load users');
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

  // --- Organization levers -------------------------------------------------

  togglePaused(org: AdminOrganization, engineActive: boolean): void {
    // The switch reads as "Engine active", so paused is its inverse.
    this.patchOrg(org, { paused: !engineActive }, engineActive ? 'Engine resumed' : 'Engine paused');
  }

  toggleSocialAutonomy(org: AdminOrganization, socialAutonomy: boolean): void {
    this.patchOrg(
      org,
      { socialAutonomy },
      socialAutonomy ? 'Autonomous social DMs enabled' : 'Autonomous social DMs disabled'
    );
  }

  saveCap(org: AdminOrganization): void {
    const cap = Number(this.capEdits[org.id]);
    if (!Number.isInteger(cap) || cap < 0) {
      this.toast.error('Daily send cap must be a whole number');
      return;
    }
    if (cap === org.dailySendCap) return;
    this.patchOrg(org, { dailySendCap: cap }, `Daily cap for ${org.name} set to ${cap}`);
  }

  private patchOrg(
    org: AdminOrganization,
    patch: { paused?: boolean; dailySendCap?: number; socialAutonomy?: boolean },
    successMessage: string
  ): void {
    const previous = this.organizations();
    this.organizations.set(previous.map(o => (o.id === org.id ? { ...o, ...patch } : o)));
    this.savingOrgId = org.id;

    this.adminService.updateOrganization(org.id, patch).subscribe({
      next: () => {
        this.savingOrgId = null;
        this.toast.success(successMessage);
      },
      error: err => {
        this.savingOrgId = null;
        this.organizations.set(previous);
        this.capEdits[org.id] = String(org.dailySendCap);
        this.toast.error(this.errorMessage(err, `Failed to update ${org.name}`));
      }
    });
  }

  // --- User levers ---------------------------------------------------------

  toggleUserActive(user: AdminUser, isActive: boolean): void {
    this.patchUser(
      user,
      { isActive },
      isActive ? `${user.email} restored` : `${user.email} suspended`
    );
  }

  changeRole(user: AdminUser, role: string): void {
    if (role === user.role) return;
    this.patchUser(user, { role }, `${user.email} is now ${role.toLowerCase()}`);
  }

  private patchUser(user: AdminUser, patch: { isActive?: boolean; role?: string }, successMessage: string): void {
    const previous = this.users();
    this.users.set(previous.map(u => (u.id === user.id ? { ...u, ...patch } : u)));
    this.savingUserId = user.id;

    this.adminService.updateUser(user.id, patch).subscribe({
      next: () => {
        this.savingUserId = null;
        this.toast.success(`${successMessage} — their sessions were signed out`);
      },
      error: err => {
        this.savingUserId = null;
        this.users.set(previous);
        this.toast.error(this.errorMessage(err, `Failed to update ${user.email}`));
      }
    });
  }

  // --- Platform settings ---------------------------------------------------

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
      error: err => {
        this.savingPlatformKey = null;
        this.toast.error(this.errorMessage(err, `Failed to save ${setting.label}`));
      }
    });
  }

  // --- Display helpers -----------------------------------------------------

  fullName(user: AdminUser): string {
    return `${user.firstName} ${user.lastName || ''}`.trim() || user.email;
  }

  roleVariant(role: string): BadgeVariant {
    if (role === 'OWNER') return 'purple';
    if (role === 'ADMIN') return 'info';
    return 'neutral';
  }

  relativeTime(iso: string | null): string {
    if (!iso) return 'never';
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  private errorMessage(err: unknown, fallback: string): string {
    const e = err as { error?: { error?: { message?: string } | string; message?: string } };
    const inner = e?.error?.error;
    if (typeof inner === 'string') return inner;
    return inner?.message || e?.error?.message || fallback;
  }
}
