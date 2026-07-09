import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class MobileMenuService {
  private readonly isOpenSignal = signal<boolean>(false);
  public readonly isOpen = this.isOpenSignal.asReadonly();

  toggle(): void {
    this.isOpenSignal.update(isOpen => !isOpen);
  }

  open(): void {
    this.isOpenSignal.set(true);
  }

  close(): void {
    this.isOpenSignal.set(false);
  }
}
