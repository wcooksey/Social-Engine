import { Component, ElementRef, HostListener, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { NotificationService } from '../../../core/services/notification.service';
import { ToastService } from '../../../core/services/toast.service';
import { AppNotification } from '../../../core/models/notification.model';

/**
 * Header bell showing the unread notification count. Clicking opens a dropdown
 * panel with the most recent notifications; a notification tied to a lead
 * navigates to its detail route. Closes on outside click or Escape.
 */
@Component({
  selector: 'app-notifications-bell',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './notifications-bell.component.html',
  styleUrl: './notifications-bell.component.scss'
})
export class NotificationsBellComponent {
  private notifications = inject(NotificationService);
  private toast = inject(ToastService);
  private router = inject(Router);
  private elementRef = inject(ElementRef<HTMLElement>);

  unread = this.notifications.unread;
  items = this.notifications.items;

  open = signal(false);
  marking = signal(false);

  toggle(): void {
    this.open.update(v => !v);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.open() && !this.elementRef.nativeElement.contains(event.target as Node)) {
      this.open.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.open.set(false);
  }

  markAllRead(): void {
    if (this.marking() || this.unread() === 0) return;
    this.marking.set(true);
    this.notifications.markAllRead().subscribe({
      next: () => this.marking.set(false),
      error: () => {
        this.marking.set(false);
        this.toast.error('Failed to mark notifications read');
      }
    });
  }

  select(notification: AppNotification): void {
    this.open.set(false);
    if (notification.leadId) {
      this.router.navigate(['/leads', notification.leadId]);
    }
  }

  /** Compact relative time label, e.g. "just now", "5m", "3h", "2d". */
  relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}w`;
    return new Date(then).toLocaleDateString();
  }

  trackById(index: number, notification: AppNotification): string {
    return notification.id;
  }
}
