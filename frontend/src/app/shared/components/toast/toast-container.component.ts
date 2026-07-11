import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService } from '../../../core/services/toast.service';

@Component({
  selector: 'app-toast-container',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-stack" role="region" aria-live="polite" aria-atomic="false">
      @for (toast of toastService.toasts(); track toast.id) {
        <div class="toast toast-{{ toast.kind }}"
             role="status"
             (click)="toastService.dismiss(toast.id)">
          <i class="bi" [ngClass]="iconFor(toast.kind)" aria-hidden="true"></i>
          <span class="toast-message">{{ toast.message }}</span>
          <button type="button"
                  class="toast-close"
                  aria-label="Dismiss"
                  (click)="$event.stopPropagation(); toastService.dismiss(toast.id)">
            <i class="bi bi-x"></i>
          </button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      position: fixed;
      top: 24px;
      right: 24px;
      z-index: 10000;
      pointer-events: none;
    }

    .toast-stack {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: min(420px, calc(100vw - 48px));
    }

    .toast {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 10px;
      background: var(--bg-secondary, #1f2937);
      color: var(--text-primary, #fff);
      border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.1));
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.2);
      font-size: 14px;
      line-height: 1.35;
      cursor: pointer;
      animation: toast-in 180ms ease-out;
    }

    .toast i.bi:first-child {
      font-size: 18px;
      flex-shrink: 0;
    }

    .toast-message {
      flex: 1;
      word-break: break-word;
    }

    .toast-close {
      background: transparent;
      border: 0;
      color: inherit;
      opacity: 0.6;
      cursor: pointer;
      padding: 0 2px;
      font-size: 18px;
      line-height: 1;
    }

    .toast-close:hover { opacity: 1; }

    .toast-success {
      border-color: rgba(16, 185, 129, 0.45);
      background: linear-gradient(180deg, rgba(16, 185, 129, 0.12), rgba(16, 185, 129, 0.04)), var(--bg-secondary, #1f2937);
    }
    .toast-success i.bi:first-child { color: #10b981; }

    .toast-error {
      border-color: rgba(239, 68, 68, 0.5);
      background: linear-gradient(180deg, rgba(239, 68, 68, 0.12), rgba(239, 68, 68, 0.04)), var(--bg-secondary, #1f2937);
    }
    .toast-error i.bi:first-child { color: #ef4444; }

    .toast-warning {
      border-color: rgba(234, 179, 8, 0.5);
      background: linear-gradient(180deg, rgba(234, 179, 8, 0.12), rgba(234, 179, 8, 0.04)), var(--bg-secondary, #1f2937);
    }
    .toast-warning i.bi:first-child { color: #eab308; }

    .toast-info {
      border-color: rgba(99, 102, 241, 0.45);
    }
    .toast-info i.bi:first-child { color: #6366f1; }

    @keyframes toast-in {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `]
})
export class ToastContainerComponent {
  toastService = inject(ToastService);

  iconFor(kind: string): string {
    switch (kind) {
      case 'success': return 'bi-check-circle-fill';
      case 'error': return 'bi-exclamation-circle-fill';
      case 'warning': return 'bi-exclamation-triangle-fill';
      default: return 'bi-info-circle-fill';
    }
  }
}
