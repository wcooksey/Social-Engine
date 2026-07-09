import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ExperimentsService, ExperimentInput } from '../../core/services/experiments.service';
import { Experiment, ExperimentChannel, ExperimentStatus, ExperimentVariant } from '../../core/models/experiment.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';
import { BadgeComponent, BadgeVariant } from '../../shared/components/badge/badge.component';
import { DialogComponent } from '../../shared/components/dialog/dialog.component';
import { ToastService } from '../../core/services/toast.service';

interface VariantRow {
  label: string;
  content: string;
}

interface ExperimentForm {
  name: string;
  channel: ExperimentChannel;
  goal: string;
  variants: VariantRow[];
}

function emptyVariantRow(): VariantRow {
  return { label: '', content: '' };
}

function emptyForm(): ExperimentForm {
  return {
    name: '',
    channel: 'EMAIL',
    goal: '',
    variants: [emptyVariantRow(), emptyVariantRow()]
  };
}

@Component({
  selector: 'app-experiments',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CardComponent,
    ButtonComponent,
    InputComponent,
    SelectComponent,
    BadgeComponent,
    DialogComponent
  ],
  templateUrl: './experiments.component.html',
  styleUrl: './experiments.component.scss'
})
export class ExperimentsComponent implements OnInit {
  experiments = signal<Experiment[]>([]);
  loading = signal(true);

  // experimentId -> leadingVariantId, populated lazily from the detail endpoint
  // (the list endpoint doesn't include the computed front-runner).
  leadingByExperiment = signal<Record<string, string | null>>({});

  showDialog = signal(false);
  saving = signal(false);
  updatingId = signal<string | null>(null);

  channelOptions: SelectOption[] = [
    { label: 'Email', value: 'EMAIL' },
    { label: 'SMS', value: 'SMS' },
    { label: 'Voice', value: 'VOICE' },
    { label: 'Social', value: 'SOCIAL' }
  ];

  form: ExperimentForm = emptyForm();

  constructor(private experimentsService: ExperimentsService, private toast: ToastService) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.experimentsService.list().subscribe({
      next: (experiments) => {
        this.experiments.set(experiments);
        this.loading.set(false);
        this.loadLeadingVariants(experiments);
      },
      error: () => this.loading.set(false)
    });
  }

  private loadLeadingVariants(experiments: Experiment[]): void {
    for (const experiment of experiments) {
      if (experiment.status === 'COMPLETED') continue;
      this.experimentsService.get(experiment.id).subscribe({
        next: (detail) => {
          this.leadingByExperiment.update(map => ({
            ...map,
            [experiment.id]: detail.leadingVariantId ?? null
          }));
        }
      });
    }
  }

  leadingVariantId(experiment: Experiment): string | null {
    return this.leadingByExperiment()[experiment.id] ?? null;
  }

  openCreate(): void {
    this.form = emptyForm();
    this.showDialog.set(true);
  }

  addVariant(): void {
    this.form.variants = [...this.form.variants, emptyVariantRow()];
  }

  removeVariant(index: number): void {
    if (this.form.variants.length <= 2) return;
    this.form.variants = this.form.variants.filter((_, i) => i !== index);
  }

  isFormValid(): boolean {
    return (
      !!this.form.name.trim() &&
      this.form.variants.length >= 2 &&
      this.form.variants.every(v => v.label.trim() && v.content.trim())
    );
  }

  submit(): void {
    if (!this.isFormValid()) return;

    const payload: ExperimentInput = {
      name: this.form.name.trim(),
      channel: this.form.channel,
      goal: this.form.goal.trim() || undefined,
      variants: this.form.variants.map(v => ({ label: v.label.trim(), content: v.content.trim() }))
    };

    this.saving.set(true);
    this.experimentsService.create(payload).subscribe({
      next: () => {
        this.saving.set(false);
        this.showDialog.set(false);
        this.toast.success('Experiment created');
        this.load();
      },
      error: () => {
        this.saving.set(false);
        this.toast.error('Failed to create experiment');
      }
    });
  }

  toggleStatus(experiment: Experiment): void {
    const nextStatus: ExperimentStatus = experiment.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    this.updatingId.set(experiment.id);
    this.experimentsService.update(experiment.id, { status: nextStatus }).subscribe({
      next: () => {
        this.updatingId.set(null);
        this.toast.success(nextStatus === 'ACTIVE' ? 'Experiment resumed' : 'Experiment paused');
        this.load();
      },
      error: () => {
        this.updatingId.set(null);
        this.toast.error('Failed to update experiment');
      }
    });
  }

  conclude(experiment: Experiment): void {
    this.updatingId.set(experiment.id);
    this.experimentsService.update(experiment.id, { status: 'COMPLETED' }).subscribe({
      next: () => {
        this.updatingId.set(null);
        this.toast.success('Experiment concluded');
        this.load();
      },
      error: () => {
        this.updatingId.set(null);
        this.toast.error('Failed to conclude experiment');
      }
    });
  }

  channelBadgeVariant(channel: ExperimentChannel): BadgeVariant {
    switch (channel) {
      case 'EMAIL': return 'info';
      case 'SMS': return 'success';
      case 'VOICE': return 'orange';
      case 'SOCIAL': return 'purple';
      default: return 'default';
    }
  }

  statusBadgeVariant(status: ExperimentStatus): BadgeVariant {
    switch (status) {
      case 'ACTIVE': return 'success';
      case 'PAUSED': return 'warning';
      case 'COMPLETED': return 'neutral';
      default: return 'default';
    }
  }

  barWidth(variant: ExperimentVariant): string {
    return `${Math.min(100, Math.max(0, variant.responseRate * 100))}%`;
  }

  formatRate(variant: ExperimentVariant): string {
    return `${Math.round(variant.responseRate * 100)}%`;
  }

  isWinner(experiment: Experiment, variant: ExperimentVariant): boolean {
    return experiment.status === 'COMPLETED' && experiment.winnerVariantId === variant.id;
  }

  isLeading(experiment: Experiment, variant: ExperimentVariant): boolean {
    if (experiment.status === 'COMPLETED') return false;
    return this.leadingVariantId(experiment) === variant.id;
  }
}
