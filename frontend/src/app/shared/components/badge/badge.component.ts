import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

export type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'purple' | 'orange';
export type BadgeSize = 'xs' | 'sm' | 'md' | 'lg';

@Component({
  selector: 'app-badge',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './badge.component.html',
  styleUrls: ['./badge.component.scss']
})
export class BadgeComponent {
  @Input() variant: BadgeVariant = 'default';
  @Input() size: BadgeSize = 'md';
  @Input() icon?: string;
  @Input() pill: boolean = false;

  getBadgeClasses(): string {
    const classes = ['badge'];
    classes.push(`badge--${this.variant}`);
    classes.push(`badge--${this.size}`);
    if (this.pill) classes.push('badge--pill');
    return classes.join(' ');
  }
}

