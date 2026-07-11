import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, OnChanges, SimpleChanges, ElementRef, ViewChild, signal, ChangeDetectionStrategy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dialog.component.html',
  styleUrls: ['./dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DialogComponent implements OnInit, OnDestroy, OnChanges {
  @Input() title: string = '';
  @Input() show: boolean = false;
  @Input() size: 'sm' | 'md' | 'lg' | 'xl' = 'md';
  @Input() closable: boolean = true;
  @Output() close = new EventEmitter<void>();
  
  @ViewChild('dialogBackdrop') backdrop?: ElementRef<HTMLDivElement>;
  @ViewChild('dialogContainer') dialogContainer?: ElementRef<HTMLDivElement>;
  
  isOpen = signal<boolean>(false);
  private previouslyFocusedElement: HTMLElement | null = null;
  private mainContentEl: HTMLElement | null = null;
  private mainContentPrevOverflow: string = '';
  // Where the backdrop lived in the component's own view before we teleported it
  // to <body>. Restored before *ngIf removes it so Angular tears it down cleanly.
  private backdropOriginalParent: Node | null = null;
  private backdropOriginalNextSibling: Node | null = null;

  ngOnInit(): void {
    this.isOpen.set(this.show);
    if (this.show) {
      this.openDialog();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['show']) {
      if (this.show) {
        this.isOpen.set(this.show);
        this.openDialog();
      } else {
        // Restore the teleported node before isOpen flips and *ngIf removes it.
        this.restoreFromBody();
        this.isOpen.set(this.show);
        this.restoreFocus();
        this.unlockScroll();
      }
    }
  }

  @HostListener('document:keydown', ['$event'])
  handleEscapeKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.isOpen() && this.closable) {
      this.closeDialog();
    }
  }

  ngOnDestroy(): void {
    // If we're destroyed while open, make sure the teleported node doesn't get
    // orphaned in <body> and that scroll locks are released.
    const el = this.backdrop?.nativeElement;
    if (el && el.parentElement === document.body) {
      el.remove();
    }
    this.backdropOriginalParent = null;
    this.backdropOriginalNextSibling = null;
    this.restoreFocus();
    this.unlockScroll();
  }

  /** Release body + main-content scroll locks. */
  private unlockScroll(): void {
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.width = '';
    document.body.style.top = '';
    this.restoreMainContentScroll();
  }

  private openDialog(): void {
    // Store currently focused element
    this.previouslyFocusedElement = document.activeElement as HTMLElement;
    
    // Prevent body scroll
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
    document.body.style.top = '0';
    
    this.lockMainContentScroll();

    // Teleport + focus trap after the *ngIf view has rendered.
    setTimeout(() => {
      this.teleportToBody();

      const firstFocusable = this.dialogContainer?.nativeElement.querySelector(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      ) as HTMLElement;
      if (firstFocusable) {
        // Focus without scrolling the page
        firstFocusable.focus({ preventScroll: true });
      }
    }, 0);
  }

  /**
   * Move the backdrop to <body> so its `position: fixed` is anchored to the
   * viewport. Inside the app it lives in `.main-content`, which on mobile is a
   * `-webkit-overflow-scrolling: touch` scroll container — iOS Safari traps
   * fixed descendants of such containers (and transformed ancestors do the same),
   * which made the dialog scroll with the page and pushed the date/time pickers
   * and footer out of the viewport.
   */
  private teleportToBody(): void {
    const el = this.backdrop?.nativeElement;
    if (!el || el.parentElement === document.body) return;
    this.backdropOriginalParent = el.parentNode;
    this.backdropOriginalNextSibling = el.nextSibling;
    document.body.appendChild(el);
  }

  /**
   * Put the backdrop back where Angular created it, so the `*ngIf` (or component
   * destroy) removes it from the parent it expects — avoids a NotFoundError.
   */
  private restoreFromBody(): void {
    const el = this.backdrop?.nativeElement;
    if (el && this.backdropOriginalParent && el.parentElement === document.body) {
      this.backdropOriginalParent.insertBefore(el, this.backdropOriginalNextSibling);
    }
    this.backdropOriginalParent = null;
    this.backdropOriginalNextSibling = null;
  }

  closeDialog(): void {
    if (this.closable) {
      // Restore the teleported node before *ngIf removes it on the next CD pass.
      this.restoreFromBody();
      this.isOpen.set(false);
      this.restoreFocus();
      this.unlockScroll();
      this.close.emit();
    }
  }

  private lockMainContentScroll(): void {
    // Our app uses a scrolling container (`.main-content`) on mobile, not window/body.
    // Without locking that container, touch scrolling can move the page behind the dialog.
    if (this.mainContentEl) return;
    const el = document.querySelector('.main-content') as HTMLElement | null;
    if (!el) return;
    this.mainContentEl = el;
    this.mainContentPrevOverflow = el.style.overflow;
    el.style.overflow = 'hidden';
    el.style.position = 'fixed';
    el.style.width = '100%';
    el.style.height = '100%';
    // Prevent any touch-based scrolling on iOS
    el.style.touchAction = 'none';
  }

  private restoreMainContentScroll(): void {
    if (!this.mainContentEl) return;
    this.mainContentEl.style.overflow = this.mainContentPrevOverflow;
    this.mainContentEl.style.position = '';
    this.mainContentEl.style.width = '';
    this.mainContentEl.style.height = '';
    this.mainContentEl.style.touchAction = '';
    this.mainContentEl = null;
    this.mainContentPrevOverflow = '';
  }

  private restoreFocus(): void {
    if (this.previouslyFocusedElement) {
      this.previouslyFocusedElement.focus();
      this.previouslyFocusedElement = null;
    }
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === this.backdrop?.nativeElement && this.closable) {
      this.closeDialog();
    }
  }

  onDialogClick(event: MouseEvent): void {
    event.stopPropagation();
  }
}

