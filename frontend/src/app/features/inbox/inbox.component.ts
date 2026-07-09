import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { debounceTime, distinctUntilChanged, Subject } from 'rxjs';
import { ConversationsService } from '../../core/services/conversations.service';
import { ConversationDetail, ConversationSummary } from '../../core/models/conversation.model';
import { ToastService } from '../../core/services/toast.service';
import { InputComponent } from '../../shared/components/input/input.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';

@Component({
  selector: 'app-inbox',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, InputComponent, SelectComponent, BadgeComponent],
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

  search = '';
  channel = '';
  page = 1;

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
    return ['draft', 'failed'].includes(status.toLowerCase());
  }

  statusBadgeVariant(status?: string | null): BadgeVariant {
    if (!status) return 'default';
    return status.toLowerCase() === 'failed' ? 'error' : 'neutral';
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
