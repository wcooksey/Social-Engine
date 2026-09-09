import { Component, computed, effect, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ModelsService } from '../../../core/services/models.service';
import { ToastService } from '../../../core/services/toast.service';
import { FormsModule } from '@angular/forms';
import { SelectComponent } from '../../../shared/components/select/select.component';
import { ModelOption } from '../../../core/models/model.model';

/** Shared select for the organization-wide Engine model, preserving catalog and
 * provider-key warnings and restoring the saved value if an update fails. */
@Component({
  selector: 'app-model-picker',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectComponent],
  templateUrl: './model-picker.component.html',
  styleUrl: './model-picker.component.scss'
})
export class ModelPickerComponent implements OnInit {
  private modelsService = inject(ModelsService);
  private toast = inject(ToastService);


  models = this.modelsService.modelOptionsWithCurrent;
  currentModelId = this.modelsService.currentModel;
  loaded = this.modelsService.loaded;

  selectedId = signal<string | null>(null);
  options = computed(() => this.models().map(m => ({ value: m.id, label: `${m.label} · ${m.providerLabel}${m.recommended ? ' · Recommended' : ''}${m.configured ? '' : ' · API key needed'}` })));
  constructor() { effect(() => this.selectedId.set(this.currentModelId()), { allowSignalWrites: true }); }
  switchingId = signal<string | null>(null);

  ngOnInit(): void {
    if (!this.loaded()) {
      this.modelsService.getModels().subscribe({ error: () => this.toast.error('Could not load Engine models') });
    }
  }

  selectById(id: string): void {
    const option = this.models().find(m => m.id === id);
    if (option) { this.selectedId.set(id); this.select(option); }
  }

  select(option: ModelOption): void {
    if (option.id === this.currentModelId() || this.switchingId()) {
      return;
    }
    this.switchingId.set(option.id);
    this.modelsService.setModel(option.id).subscribe({
      next: () => {
        this.switchingId.set(null);
        this.selectedId.set(this.currentModelId());
        // Let the user pick any model, but warn if its provider key is missing.
        if (option.configured) {
          this.toast.success(`Engine model set to ${option.label}`);
        } else {
          this.toast.warning(`Set to ${option.label} — add the ${option.providerLabel} API key in Settings → Integrations to use it.`);
        }
      },
      error: () => {
        this.switchingId.set(null);
        this.selectedId.set(this.currentModelId());
        this.toast.error('Failed to switch the Engine model');
      }
    });
  }

}
