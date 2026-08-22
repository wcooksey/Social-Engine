import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { debounceTime, distinctUntilChanged, Subject } from 'rxjs';
import { ConversationsService } from '../../core/services/conversations.service';
import { ConversationDetail, ConversationSummary, Message } from '../../core/models/conversation.model';
import { ToastService } from '../../core/services/toast.service';
import { InputComponent } from '../../shared/components/input/input.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { ChatAmbientComponent } from '../../shared/components/chat-ambient/chat-ambient.component';

@Component({
  selector: 'app-inbox',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, InputComponent, SelectComponent, BadgeComponent, ButtonComponent, ChatAmbientComponent],
  templateUrl: './inbox.component.html',
  styleUrl: './inbox.component.scss'
})
export class InboxComponent implements OnInit {
  conversations = signal<ConversationSummary[]>([]);
  total = signal(0);
  loading = signal(false);

  selectedId = signal<string | null>(null);
  selectedConversation = signal<ConversationDetail | null>(null);
  loadingDetail = signal(false);

  mobileShowThread = signal(false);

  sendingReply = signal(false);
  // Message id of the draft currently being approved/discarded, if any.
  actingMessageId = signal<string | null>(null);

  replyBody = '';

  search = '';
  channel = '';
  page = 1;
  // Mirrors the API's fixed inbox page size.
  readonly pageSize = 25;

  channelOptions: SelectOption[] = [
    { label: 'Email', value: 'EMAIL' },
    { label: 'SMS', value: 'SMS' },
    { label: 'Voice', value: 'VOICE' },
    { label: 'Social', value: 'SOCIAL' }
  ];

  private searchInput$ = new Subject<string>();

  constructor(
    private conversationsService: ConversationsService,
    private toast: ToastService
  ) {
    this.searchInput$.pipe(debounceTime(300), distinctUntilChanged()).subscribe(value => {
      this.search = value;
      this.page = 1;
      this.load();
    });
  }

  ngOnInit(): void {
    this.load();
  }

  onSearchChange(value: string): void {
    this.searchInput$.next(value);
  }

  onFilterChange(): void {
    this.page = 1;
    this.load();
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.total() / this.pageSize));
  }

  goToPage(page: number): void {
    const clamped = Math.min(Math.max(1, page), this.totalPages);
    if (clamped === this.page) return;
    this.page = clamped;
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.conversationsService
      .listInbox({
        channel: this.channel || undefined,
        search: this.search || undefined,
        page: this.page
      })
      .subscribe({
        next: (res) => {
          this.conversations.set(res.conversations);
          this.total.set(res.total);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.toast.error('Failed to load conversations');
        }
      });
  }

  selectConversation(summary: ConversationSummary): void {
    this.selectedId.set(summary.id);
    this.mobileShowThread.set(true);
    this.replyBody = '';
    this.loadingDetail.set(true);
    this.conversationsService.getConversation(summary.id).subscribe({
      next: (detail) => {
        this.selectedConversation.set(detail);
        this.loadingDetail.set(false);
      },
      error: () => {
        this.loadingDetail.set(false);
        this.toast.error('Failed to load conversation');
      }
    });
  }

  backToList(): void {
    this.mobileShowThread.set(false);
  }

  /** Reload the open thread (without the full-pane spinner) and the list previews. */
  refreshThread(): void {
    const id = this.selectedId();
    if (!id) return;
    this.conversationsService.getConversation(id).subscribe({
      next: (detail) => this.selectedConversation.set(detail),
      error: () => this.toast.error('Failed to refresh conversation')
    });
    this.load();
  }

  canReply(convo: ConversationDetail): boolean {
    return convo.channel === 'EMAIL' || convo.channel === 'SMS';
  }

  isDraft(message: Message): boolean {
    return message.direction === 'OUTBOUND' && !!message.status?.startsWith('draft');
  }

  draftLabel(message: Message): string {
    return message.status === 'draft_blocked' ? 'Draft — blocked' : 'Draft — pending approval';
  }

  /**
   * A message the send queue is holding for sender pacing. It has not reached
   * anyone, so it must not read as sent — and it can still be cancelled.
   */
  isQueued(message: Message): boolean {
    return message.direction === 'OUTBOUND' && message.status === 'scheduled';
  }

  queuedLabel(message: Message): string {
    if (!message.scheduledAt) return 'Queued — sends shortly';
    const due = new Date(message.scheduledAt);
    const sameDay = due.toDateString() === new Date().toDateString();
    return `Queued — sends ${due.toLocaleString(undefined, sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  }

  sendReply(convo: ConversationDetail): void {
    const body = this.replyBody.trim();
    if (!body || this.sendingReply()) return;
    this.sendingReply.set(true);
    this.conversationsService.sendMessage(convo.id, body).subscribe({
      next: () => {
        this.sendingReply.set(false);
        this.replyBody = '';
        this.toast.success('Reply sent');
        this.refreshThread();
      },
      error: (err) => {
        this.sendingReply.set(false);
        this.toast.error(this.errorMessage(err, 'Failed to send reply'));
      }
    });
  }

  approveDraft(convo: ConversationDetail, message: Message): void {
    if (this.actingMessageId()) return;
    this.actingMessageId.set(message.id);
    this.conversationsService.approveDraft(convo.id, message.id).subscribe({
      next: () => {
        this.actingMessageId.set(null);
        this.toast.success('Draft approved and sent');
        this.refreshThread();
      },
      error: (err) => {
        this.actingMessageId.set(null);
        this.toast.error(this.errorMessage(err, 'Failed to send draft'));
      }
    });
  }

  discardDraft(convo: ConversationDetail, message: Message): void {
    if (this.actingMessageId()) return;
    this.actingMessageId.set(message.id);
    this.conversationsService.discardDraft(convo.id, message.id).subscribe({
      next: () => {
        this.actingMessageId.set(null);
        this.toast.success('Draft discarded');
        this.refreshThread();
      },
      error: (err) => {
        this.actingMessageId.set(null);
        this.toast.error(this.errorMessage(err, 'Failed to discard draft'));
      }
    });
  }

  private errorMessage(err: any, fallback: string): string {
    return err?.error?.error || err?.error?.message || fallback;
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

  showStatusBadge(status?: string | null): boolean {
    if (!status) return false;
    return ['draft', 'failed', 'scheduled', 'cancelled'].includes(status.toLowerCase());
  }

  statusBadgeVariant(status?: string | null): BadgeVariant {
    if (!status) return 'default';
    const value = status.toLowerCase();
    if (value === 'failed') return 'error';
    if (value === 'scheduled') return 'info';
    return 'neutral';
  }

  contactName(contact: { name: string } | null): string {
    return contact?.name || 'Unknown contact';
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
