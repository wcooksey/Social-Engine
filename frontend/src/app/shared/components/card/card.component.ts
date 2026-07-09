import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './card.component.html',
  styleUrl: './card.component.scss'
})
export class CardComponent {
  @Input() variant: 'default' | 'elevated' | 'outlined' | 'flat' = 'default';
  @Input() padding: 'sm' | 'md' | 'lg' = 'md';
  @Input() hoverable: boolean = false;
  @Input() selected: boolean = false;

  getCardClasses(): string {
    const classes = ['card'];
    classes.push(`card--${this.variant}`);
    classes.push(`card--padding-${this.padding}`);
    if (this.hoverable) classes.push('card--hoverable');
    if (this.selected) classes.push('card--selected');
    return classes.join(' ');
  }
}

