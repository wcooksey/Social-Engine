import { Injectable, signal } from '@angular/core';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  // Auto-dismiss after this many ms (0 or negative = persistent until clicked)
  durationMs: number;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();
  private nextId = 1;

  show(message: string, kind: ToastKind = 'info', durationMs = 4000): number {
    const id = this.nextId++;
    this._toasts.update(list => [...list, { id, kind, message, durationMs }]);
    if (durationMs > 0) {
      setTimeout(() => this.dismiss(id), durationMs);
    }
    return id;
  }

  success(message: string, durationMs = 4000): number {
    return this.show(message, 'success', durationMs);
  }
  error(message: string, durationMs = 6000): number {
    return this.show(message, 'error', durationMs);
  }
  info(message: string, durationMs = 4000): number {
    return this.show(message, 'info', durationMs);
  }
  warning(message: string, durationMs = 5000): number {
    return this.show(message, 'warning', durationMs);
  }

  dismiss(id: number): void {
    this._toasts.update(list => list.filter(t => t.id !== id));
  }

  clear(): void {
    this._toasts.set([]);
  }
}
