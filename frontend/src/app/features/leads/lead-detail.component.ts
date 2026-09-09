import { inject } from '@angular/core';
import { GroupContextService } from '../../core/services/group-context.service';
import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { LeadsService } from '../../core/services/leads.service';
import {
  Contact,
  ENRICHMENT_TIER_HINT,
  ENRICHMENT_TIER_LABEL,
  EnrichmentTier,
  Lead,
  formatLeadAddress
} from '../../core/models/lead.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { DialogComponent } from '../../shared/components/dialog/dialog.component';
import { ToastService } from '../../core/services/toast.service';
import { ConversationsService } from '../../core/services/conversations.service';
import { Conversation } from '../../core/models/conversation.model';

@Component({
  selector: 'app-lead-detail',
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
  templateUrl: './lead-detail.component.html',
  styleUrl: './lead-detail.component.scss'
})
export class LeadDetailComponent implements OnInit {
  context = inject(GroupContextService);
  readonly workspaceGroupId = this.context.currentId();

  lead = signal<Lead | null>(null);
  loading = signal(true);
  savingStatus = signal(false);

  /**
   * The filtered list this lead was opened from. Read from router state, which
   * the browser keeps with the history entry so it survives a reload here.
   * Falls back to the unfiltered list only when there is nothing to go back to
   * — someone who followed a direct link to this lead.
   */
  private readonly returnUrl: string =
    (typeof history !== 'undefined' && (history.state?.returnUrl as string)) || this.context.link('leads').join('/');

  /** Return to the list you came from, filters and group intact. */
  goBack(): void {
    void this.router.navigateByUrl(this.returnUrl);
  }

  /**
   * The full street address. Sourcing has always collected this — Google Places
   * puts its formatted address on every lead — but the header only ever showed
   * city and state, so the one field that says whether a site is an industrial
   * unit or a strip-mall suite was invisible.
   */
  address(lead: Lead): string {
    return formatLeadAddress(lead);
  }

  showContactDialog = signal(false);
  editingContact: Contact | null = null;
  savingContact = signal(false);
  contactForm = { firstName: '', lastName: '', title: '', email: '', phone: '' };

  conversations = signal<Conversation[]>([]);
  loadingConversations = signal(true);
  private expandedIds = signal<Set<string>>(new Set());

  statusOptions: SelectOption[] = [
    { label: 'New', value: 'NEW' },
    { label: 'Researching', value: 'RESEARCHING' },
    { label: 'Contacted', value: 'CONTACTED' },
    { label: 'Engaged', value: 'ENGAGED' },
    { label: 'Interested', value: 'INTERESTED' },
    { label: 'Not Interested', value: 'NOT_INTERESTED' },
    { label: 'Customer', value: 'CUSTOMER' },
    { label: 'Archived', value: 'ARCHIVED' }
  ];

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private leadsService: LeadsService,
    private conversationsService: ConversationsService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.load(id);

    }
  }

  load(id: string): void {
    this.loading.set(true);
    this.leadsService.get(id, this.workspaceGroupId || undefined).subscribe({
      next: (lead) => {
        this.lead.set(lead);
        this.loadConversations(id);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.error('Failed to load lead');
      }
    });
  }

  loadConversations(leadId: string): void {
    this.loadingConversations.set(true);
    this.conversationsService.getLeadConversations(leadId).subscribe({
      next: (conversations) => {
        this.conversations.set(conversations);
        this.loadingConversations.set(false);
      },
      error: () => {
        this.loadingConversations.set(false);
        this.toast.error('Failed to load conversations');
      }
    });
  }

  isExpanded(conversationId: string): boolean {
    return this.expandedIds().has(conversationId);
  }

  toggleConversation(conversationId: string): void {
    const next = new Set(this.expandedIds());
    if (next.has(conversationId)) {
      next.delete(conversationId);
    } else {
      next.add(conversationId);
    }
    this.expandedIds.set(next);
  }

  channelIcon(channel: string): string {
    const map: Record<string, string> = {
      EMAIL: 'bi-envelope',
      SMS: 'bi-chat-dots',
      VOICE: 'bi-telephone',
      SOCIAL: 'bi-share'
    };
    return map[channel] || 'bi-chat';
  }

  channelBadgeVariant(channel: string): BadgeVariant {
    switch (channel) {
      case 'EMAIL': return 'info';
      case 'SMS': return 'success';
      case 'VOICE': return 'orange';
      case 'SOCIAL': return 'purple';
      default: return 'default';
    }
  }

  changeStatus(status: string): void {
    const lead = this.lead();
    if (!lead || !status) return;
    this.savingStatus.set(true);
    this.leadsService.update(lead.id, { status }).subscribe({
      next: (updated) => {
        this.lead.set({ ...lead, status: updated.status });
        this.savingStatus.set(false);
        this.toast.success('Status updated');
      },
      error: () => {
        this.savingStatus.set(false);
        this.toast.error('Failed to update status');
      }
    });
  }

  openAddContact(): void {
    this.editingContact = null;
    this.contactForm = { firstName: '', lastName: '', title: '', email: '', phone: '' };
    this.showContactDialog.set(true);
  }

  openEditContact(contact: Contact): void {
    this.editingContact = contact;
    this.contactForm = {
      firstName: contact.firstName,
      lastName: contact.lastName,
      title: contact.title || '',
      email: contact.email || '',
      phone: contact.phone || ''
    };
    this.showContactDialog.set(true);
  }

  submitContact(): void {
    const lead = this.lead();
    if (!lead) return;
    this.savingContact.set(true);

    const request$ = this.editingContact
      ? this.leadsService.updateContact(this.editingContact.id, this.contactForm)
      : this.leadsService.addContact(lead.id, this.contactForm);

    request$.subscribe({
      next: (contact) => {
        const contacts = lead.contacts ? [...lead.contacts] : [];
        if (this.editingContact) {
          const idx = contacts.findIndex(c => c.id === this.editingContact!.id);
          if (idx >= 0) contacts[idx] = contact;
        } else {
          contacts.push(contact);
        }
        this.lead.set({ ...lead, contacts });
        this.savingContact.set(false);
        this.showContactDialog.set(false);
        this.toast.success(this.editingContact ? 'Contact updated' : 'Contact added');
        // The server re-scored the lead on this write — pull the fresh snapshot.
        this.load(lead.id);
      },
      error: () => {
        this.savingContact.set(false);
        this.toast.error('Failed to save contact');
      }
    });
  }

  deleteContact(contact: Contact): void {
    const lead = this.lead();
    if (!lead) return;
    this.leadsService.deleteContact(contact.id).subscribe({
      next: () => {
        this.lead.set({ ...lead, contacts: (lead.contacts || []).filter(c => c.id !== contact.id) });
        this.toast.success('Contact removed');
        this.load(lead.id);
      },
      error: () => this.toast.error('Failed to remove contact')
    });
  }

  statusBadgeVariant(status: string): BadgeVariant {
    switch (status) {
      case 'NEW': return 'info';
      case 'RESEARCHING': return 'purple';
      case 'CONTACTED': return 'default';
      case 'ENGAGED': return 'warning';
      case 'INTERESTED': return 'success';
      case 'NOT_INTERESTED': return 'error';
      case 'CUSTOMER': return 'success';
      case 'ARCHIVED': return 'neutral';
      default: return 'default';
    }
  }

  // --- Enrichment ---------------------------------------------------------

  readonly tierLabel = ENRICHMENT_TIER_LABEL;
  readonly tierHint = ENRICHMENT_TIER_HINT;

  tierBadgeVariant(tier?: EnrichmentTier): BadgeVariant {
    switch (tier) {
      case 'RICH': return 'success';
      case 'GOOD': return 'info';
      case 'PARTIAL': return 'warning';
      case 'MINIMAL': return 'orange';
      case 'NONE': return 'error';
      default: return 'neutral';
    }
  }

  /** Turn the stored gap keys into the plain-English "still needs" list. */
  gapLabels(lead: Lead): string[] {
    const labels: Record<string, string> = {
      email: 'an email address',
      named_contact: 'a named person',
      decision_maker: 'a decision maker',
      verified_email: 'a verified email',
      direct_phone: 'a direct phone',
      website: 'a website',
      company_phone: 'a company phone',
      location: 'a location',
      social: 'a social profile'
    };
    return (lead.enrichmentGaps || []).map(gap => labels[gap] || gap);
  }

  /**
   * Whether the Engine considers this lead worked-out under the current
   * capabilities — i.e. another research pass would likely find nothing new.
   */
  enrichmentExhausted(lead: Lead): boolean {
    return (lead.enrichmentAttempts ?? 0) > 0 && (lead.enrichmentTier === 'NONE' || lead.enrichmentTier === 'MINIMAL' || lead.enrichmentTier === 'PARTIAL');
  }

  activityIcon(type: string): string {
    const map: Record<string, string> = {
      EMAIL_SENT: 'bi-envelope',
      SMS_SENT: 'bi-chat-dots',
      CALL_MADE: 'bi-telephone',
      NOTE: 'bi-sticky',
      STATUS_CHANGE: 'bi-arrow-repeat',
      RESEARCH: 'bi-search'
    };
    return map[type] || 'bi-dot';
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
}
