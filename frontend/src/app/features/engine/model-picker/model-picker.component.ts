import { Component, ElementRef, HostListener, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ModelsService } from '../../../core/services/models.service';
import { ToastService } from '../../../core/services/toast.service';
import { ModelOption } from '../../../core/models/model.model';

/**
 * Compact pill in the Engine console header showing the active model.
 * Clicking opens a small dropdown panel (grouped/labeled by provider) to
 * switch the org's active Engine model on the fly.
 */
@Component({
  selector: 'app-model-picker',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './model-picker.component.html',
  styleUrl: './model-picker.component.scss'
})
export class ModelPickerComponent implements OnInit {
  private modelsService = inject(ModelsService);
  private toast = inject(ToastService);
  private elementRef = inject(ElementRef<HTMLElement>);

  models = this.modelsService.models;
  currentModelId = this.modelsService.currentModel;
  currentOption = this.modelsService.currentModelOption;
  loaded = this.modelsService.loaded;

  open = signal(false);
  switchingId = signal<string | null>(null);

  ngOnInit(): void {
    if (!this.loaded()) {
      this.modelsService.getModels().subscribe();
    }
  }

  toggle(): void {
    if (this.switchingId()) return;
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

  select(option: ModelOption): void {
    if (option.id === this.currentModelId() || this.switchingId()) {
      return;
    }
    this.switchingId.set(option.id);
    this.modelsService.setModel(option.id).subscribe({
      next: () => {
        this.switchingId.set(null);
        this.open.set(false);
        // Let the user pick any model, but warn if its provider key is missing.
        if (option.configured) {
          this.toast.success(`Engine model set to ${option.label}`);
        } else {
          this.toast.warning(`Set to ${option.label} — add the ${option.providerLabel} API key in Settings → Integrations to use it.`);
        }
      },
      error: () => {
        this.switchingId.set(null);
        this.toast.error('Failed to switch the Engine model');
      }
    });
  }

  trackByModelId(index: number, option: ModelOption): string {
    return option.id;
  }
}
