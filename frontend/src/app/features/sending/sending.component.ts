import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SendingService } from '../../core/services/sending.service';
import {
  DomainPurpose,
  GmailAccount,
  Mailbox,
  SendingDomain,
  SenderPool
} from '../../core/models/sending.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { DialogComponent } from '../../shared/components/dialog/dialog.component';
import { ToastService } from '../../core/services/toast.service';
import { NativeAppService } from '../../core/services/native-app.service';

const PURPOSE_OPTIONS: SelectOption[] = [
  { value: 'COLD_OUTREACH', label: 'Cold outreach' },
  { value: 'TRANSACTIONAL', label: 'Transactional (invites, reminders)' }
];

@Component({
  selector: 'app-sending',
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
  templateUrl: './sending.component.html',
  styleUrl: './sending.component.scss'
})
export class SendingComponent implements OnInit {
  private sending = inject(SendingService);
  private toast = inject(ToastService);
  private nativeApp = inject(NativeAppService);

  readonly purposeOptions = PURPOSE_OPTIONS;
  overview = this.sending.overview;
  pools = this.sending.pools;
  gmail = this.sending.gmail;
  loading = signal(true);
  busy = signal<string | null>(null);

  domains = computed<SendingDomain[]>(() => this.overview()?.domains ?? []);
  coldDomains = computed(() => this.domains().filter(d => d.purpose === 'COLD_OUTREACH'));
  hasTransactional = computed(() => this.domains().some(d => d.purpose === 'TRANSACTIONAL'));

  /** Every mailbox across every domain — the pool editor picks from these. */
  allMailboxes = computed<Mailbox[]>(() => this.domains().flatMap(d => d.mailboxes));

  /** Total cold-outreach sends still available today. */
  capacityToday = computed(() =>
    this.coldDomains()
      .filter(d => d.status === 'WARMING' || d.status === 'ACTIVE')
      .flatMap(d => d.mailboxes)
      .filter(m => m.status === 'WARMING' || m.status === 'ACTIVE')
      .reduce((total, m) => total + m.remainingToday, 0)
  );

  // --- dialogs -------------------------------------------------------------
  domainDialog = signal(false);
  newDomain = signal('');
  newPurpose = signal<DomainPurpose>('COLD_OUTREACH');
  newApiKey = signal('');

  mailboxDialog = signal<SendingDomain | null>(null);
  newLocalPart = signal('');
  newDisplayName = signal('');
  newDailyCapMax = signal(40);
  newHourlyCap = signal(8);

  poolDialog = signal<SenderPool | null | 'new'>(null);
  poolName = signal('');
  poolMailboxIds = signal<string[]>([]);

  inboxes = computed<GmailAccount[]>(() => this.gmail()?.accounts ?? []);
  /** Sends left today across every connected inbox. */
  inboxCapacityToday = computed(() =>
    this.inboxes()
      .filter(account => account.status === 'CONNECTED')
      .reduce((total, account) => total + account.remainingToday, 0)
  );

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading.set(true);
    this.sending.load().subscribe({
      next: () => {
        // Fire-and-forget alongside the pools load: a Gmail read failing must
        // not take the domains view down with it, since the two are unrelated
        // halves of the page.
        this.sending.loadGmail().subscribe({ error: () => undefined });
        this.sending.loadPools().subscribe({
          complete: () => this.loading.set(false),
          // Without its own handler the spinner would run forever on any pools
          // error, with nothing on screen to say why.
          error: err => {
            this.loading.set(false);
            this.toast.error(this.reason(err, 'Could not load sender pools'));
          }
        });
      },
      error: err => {
        this.loading.set(false);
        this.toast.error(this.reason(err, 'Could not load sending setup'));
      }
    });
  }

  private reason(err: unknown, fallback: string): string {
    const message = (err as { error?: { error?: string } })?.error?.error;
    return message || fallback;
  }

  /**
   * Run a mutation, then refresh. `onSuccess` closes the originating dialog only
   * once the request has actually been accepted — closing first would throw away
   * everything the user typed the moment the backend rejects a field.
   */
  private run(
    key: string,
    work: { subscribe: Function },
    success: string,
    onSuccess?: () => void
  ): void {
    this.busy.set(key);
    (work as any).subscribe({
      next: () => {
        this.busy.set(null);
        onSuccess?.();
        this.toast.success(success);
        this.refresh();
      },
      error: (err: unknown) => {
        this.busy.set(null);
        this.toast.error(this.reason(err, 'That did not work'));
      }
    });
  }

  /** Numeric inputs come back as strings, and empty when cleared. */
  private num(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
  }

  // --- presentation --------------------------------------------------------

  domainVariant(domain: SendingDomain): BadgeVariant {
    switch (domain.status) {
      case 'ACTIVE':
        return 'success';
      case 'WARMING':
        return 'info';
      case 'PENDING':
        return 'warning';
      case 'PAUSED':
        return 'error';
      default:
        return 'neutral';
    }
  }

  mailboxVariant(mailbox: Mailbox): BadgeVariant {
    if (mailbox.status === 'PAUSED') return 'error';
    if (mailbox.status === 'RETIRED') return 'neutral';
    if (mailbox.rampHalted) return 'warning';
    return mailbox.status === 'ACTIVE' ? 'success' : 'info';
  }

  /** Which named DNS records are still outstanding, for the setup checklist. */
  missingDns(domain: SendingDomain): string[] {
    const missing: string[] = [];
    if (domain.dns.spf !== true) missing.push('SPF');
    if (domain.dns.dkim !== true) missing.push('DKIM');
    if (domain.dns.mx !== true) missing.push('MX (needed to receive replies)');
    if (domain.dns.tracking !== true) missing.push('tracking CNAME');
    return missing;
  }

  canSend(domain: SendingDomain): boolean {
    return domain.status === 'WARMING' || domain.status === 'ACTIVE';
  }

  /** Day of the warm-up ramp a mailbox is on, for the progress label. */
  warmupDay(mailbox: Mailbox): number | null {
    if (!mailbox.warmupStartedAt) return null;
    const started = new Date(mailbox.warmupStartedAt).getTime();
    return Math.max(0, Math.floor((Date.now() - started) / 86_400_000));
  }

  usedPercent(mailbox: Mailbox): number {
    if (mailbox.allowanceToday <= 0) return 100;
    const used = mailbox.allowanceToday - mailbox.remainingToday;
    return Math.min(100, Math.round((used / mailbox.allowanceToday) * 100));
  }

  ratePercent(rate: number): string {
    return `${(rate * 100).toFixed(2)}%`;
  }

  // --- actions -------------------------------------------------------------

  adopt(): void {
    this.run('adopt', this.sending.adoptLegacy(), 'Existing Mailgun domain adopted — it keeps sending exactly as before.');
  }

  openDomainDialog(): void {
    this.newDomain.set('');
    this.newPurpose.set('COLD_OUTREACH');
    this.newApiKey.set('');
    this.domainDialog.set(true);
  }

  saveDomain(): void {
    const domain = this.newDomain().trim();
    if (!domain) {
      this.toast.error('Enter a domain');
      return;
    }
    this.run(
      'add-domain',
      this.sending.addDomain(domain, this.newPurpose(), this.newApiKey().trim() || undefined),
      `${domain} added. Publish its DNS records at your registrar, then verify.`,
      () => this.domainDialog.set(false)
    );
  }

  verify(domain: SendingDomain): void {
    this.run(`verify-${domain.id}`, this.sending.verifyDomain(domain.id), `Re-checked DNS for ${domain.domain}.`);
  }

  setDomainStatus(domain: SendingDomain, status: string): void {
    this.run(`domain-${domain.id}`, this.sending.updateDomain(domain.id, { status }), `${domain.domain} is now ${status.toLowerCase()}.`);
  }

  removeDomain(domain: SendingDomain): void {
    if (!confirm(`Remove ${domain.domain} and its ${domain.mailboxes.length} mailbox(es)? Messages already sent keep their history.`)) return;
    this.run(`domain-${domain.id}`, this.sending.deleteDomain(domain.id), `${domain.domain} removed.`);
  }

  openMailboxDialog(domain: SendingDomain): void {
    this.newLocalPart.set('');
    this.newDisplayName.set('');
    this.newDailyCapMax.set(40);
    this.newHourlyCap.set(8);
    this.mailboxDialog.set(domain);
  }

  saveMailbox(): void {
    const domain = this.mailboxDialog();
    if (!domain) return;
    const localPart = this.newLocalPart().trim();
    if (!localPart) {
      this.toast.error('Enter the part before the @');
      return;
    }
    this.run(
      'add-mailbox',
      this.sending.addMailbox(domain.id, {
        localPart,
        displayName: this.newDisplayName().trim() || undefined,
        dailyCapMax: this.num(this.newDailyCapMax(), 40),
        hourlyCap: this.num(this.newHourlyCap(), 8)
      }),
      `${localPart}@${domain.domain} added — it starts warming up on its first send.`,
      () => this.mailboxDialog.set(null)
    );
  }

  setMailboxStatus(mailbox: Mailbox, status: string): void {
    this.run(
      `mailbox-${mailbox.id}`,
      this.sending.updateMailbox(mailbox.id, { status }),
      status === 'PAUSED'
        ? `${mailbox.address} paused — it stays paused until you resume it.`
        : `${mailbox.address} resumed, warming up from the start.`
    );
  }

  removeMailbox(mailbox: Mailbox): void {
    if (!confirm(`Remove ${mailbox.address}?`)) return;
    this.run(`mailbox-${mailbox.id}`, this.sending.deleteMailbox(mailbox.id), `${mailbox.address} removed.`);
  }

  // --- pools ---------------------------------------------------------------

  openPoolDialog(pool: SenderPool | 'new'): void {
    if (pool === 'new') {
      this.poolName.set('');
      this.poolMailboxIds.set([]);
    } else {
      this.poolName.set(pool.name);
      this.poolMailboxIds.set(pool.mailboxes.map(m => m.mailbox.id));
    }
    this.poolDialog.set(pool);
  }

  togglePoolMailbox(id: string): void {
    const current = this.poolMailboxIds();
    this.poolMailboxIds.set(
      current.includes(id) ? current.filter(x => x !== id) : [...current, id]
    );
  }

  inPool(id: string): boolean {
    return this.poolMailboxIds().includes(id);
  }

  savePool(): void {
    const target = this.poolDialog();
    const name = this.poolName().trim();
    if (!name) {
      this.toast.error('Name the pool');
      return;
    }
    const close = () => this.poolDialog.set(null);
    if (target === 'new') {
      this.run('pool', this.sending.createPool(name, this.poolMailboxIds()), `Pool "${name}" created.`, close);
    } else if (target) {
      this.run(
        'pool',
        this.sending.updatePool(target.id, { name, mailboxIds: this.poolMailboxIds() }),
        `Pool "${name}" updated.`,
        close
      );
    }
  }

  removePool(pool: SenderPool): void {
    const warning = pool._count.playbooks
      ? `${pool._count.playbooks} playbook(s) send through "${pool.name}". They will fall back to any cold-outreach mailbox. Continue?`
      : `Delete pool "${pool.name}"?`;
    if (!confirm(warning)) return;
    this.run('pool', this.sending.deletePool(pool.id), `Pool "${pool.name}" deleted.`);
  }

  // --- Gmail inboxes -------------------------------------------------------

  /**
   * Send the operator to Google.
   *
   * A full-page navigation rather than a popup: the consent screen often wants
   * a fresh login, and popup blockers eat the window that opens after an async
   * response. Coming back, Google lands on the callback page, which links here.
   */
  connectInbox(): void {
    this.busy.set('gmail-connect');
    this.sending.gmailAuthUrl().subscribe({
      next: ({ url }) => {
        this.busy.set(null);
        void this.nativeApp.openExternal(url).catch(() =>
          this.toast.error('Could not open sign-in. Please try again.')
        );
      },
      error: err => {
        this.busy.set(null);
        this.toast.error(this.reason(err, 'Could not start the Google connection'));
      }
    });
  }

  setInboxPaused(account: GmailAccount, paused: boolean): void {
    this.run(
      `gmail-${account.id}`,
      this.sending.updateGmailAccount(account.id, { paused }),
      paused
        ? `${account.emailAddress} paused — nothing sends from it until you resume.`
        : `${account.emailAddress} is sending again.`
    );
  }

  setInboxCap(account: GmailAccount, value: unknown): void {
    const cap = this.num(value, account.dailySendCap);
    if (cap === account.dailySendCap) return;
    this.run(
      `gmail-${account.id}`,
      this.sending.updateGmailAccount(account.id, { dailySendCap: cap }),
      `${account.emailAddress} now sends at most ${cap} a day.`
    );
  }

  syncInbox(account: GmailAccount): void {
    this.busy.set(`gmail-sync-${account.id}`);
    this.sending.syncGmailAccount(account.id).subscribe({
      next: ({ examined, matched }) => {
        this.busy.set(null);
        this.toast.success(
          matched
            ? `${matched} repl${matched === 1 ? 'y' : 'ies'} threaded onto leads.`
            : `Read ${examined} message(s) — nothing from a known lead.`
        );
        this.refresh();
      },
      error: err => {
        this.busy.set(null);
        this.toast.error(this.reason(err, 'Could not read that inbox'));
      }
    });
  }

  disconnectInbox(account: GmailAccount): void {
    const warning = account.playbookCount
      ? `Disconnect ${account.emailAddress}? ${account.playbookCount} playbook(s) send through it — they will draft their email instead of sending until you point them somewhere else.`
      : `Disconnect ${account.emailAddress}? Replies to it stop being read.`;
    if (!confirm(warning)) return;
    this.run(
      `gmail-${account.id}`,
      this.sending.disconnectGmailAccount(account.id),
      `${account.emailAddress} disconnected.`
    );
  }

  inboxVariant(account: GmailAccount): BadgeVariant {
    switch (account.status) {
      case 'CONNECTED':
        return 'success';
      case 'PAUSED':
        return 'neutral';
      case 'EXPIRED':
        return 'error';
      default:
        return 'warning';
    }
  }

  /** Plain-language state, since "EXPIRED" alone doesn't say what to do. */
  inboxStatusNote(account: GmailAccount): string | null {
    if (account.status === 'EXPIRED') {
      return 'Google has revoked this connection — reconnect it, or every playbook using it will keep drafting instead of sending.';
    }
    if (account.status === 'ERROR') {
      return account.lastError || 'Google is refusing requests for this inbox.';
    }
    if (account.status === 'PAUSED') return 'Paused by hand. Nothing sends from it.';
    return null;
  }

  inboxUsedPercent(account: GmailAccount): number {
    if (account.dailySendCap <= 0) return 100;
    return Math.min(100, Math.round((account.sentToday / account.dailySendCap) * 100));
  }
}
