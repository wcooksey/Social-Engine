import { Component, Input, Output, EventEmitter } from '@angular/core';
import { RouterModule, Params } from '@angular/router';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

@Component({
  selector: 'app-button',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './button.component.html',
  styleUrl: './button.component.scss'
})
export class ButtonComponent {
  @Input() link: string | any[] | null = null;
  @Input() queryParams: Params | null = null;
  @Input() fragment?: string;
  @Input() variant: 'primary' | 'secondary' | 'ghost' | 'danger' | 'text' = 'primary';
  @Input() size: 'sm' | 'md' | 'lg' = 'md';
  @Input() type: 'button' | 'submit' | 'reset' = 'button';
  @Input() disabled: boolean = false;
  @Input() loading: boolean = false;
  @Input() fullWidth: boolean = false;
  /**
   * When true, the button renders as an icon-only square button (no projected content).
   * This avoids extra spacing when using icons without a label.
   */
  @Input() iconOnly: boolean = false;
  /**
   * When true, renders the button in a more compact style on mobile breakpoints only.
   * Useful for fitting multiple action buttons side-by-side in tight layouts.
   */
  @Input() compactOnMobile: boolean = false;
  @Input() icon?: string; // Bootstrap icon class (e.g., 'bi-google')
  @Input() iconPosition: 'left' | 'right' = 'left';
  @Input() customIcon?: string; // Custom SVG or image HTML string

  @Output() clicked = new EventEmitter<void>();

  constructor(private sanitizer: DomSanitizer) {}

  get safeCustomIcon(): SafeHtml | null {
    return this.customIcon ? this.sanitizer.bypassSecurityTrustHtml(this.customIcon) : null;
  }

  onClick(event: MouseEvent): void {
    if (this.disabled || this.loading) { event.preventDefault(); return; }
    if (!this.disabled && !this.loading) {
      this.clicked.emit();
    }
  }

  getButtonClasses(): string {
    const classes = ['button'];
    classes.push(`button--${this.variant}`);
    classes.push(`button--${this.size}`);
    if (this.fullWidth) classes.push('button--full-width');
    if (this.iconOnly) classes.push('button--icon-only');
    if (this.compactOnMobile) classes.push('button--compact-mobile');
    return classes.join(' ');
  }
}

