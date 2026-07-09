import { Component, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/services/auth.service';
import { OrganizationService } from '../../core/services/organization.service';
import { ThemeService } from '../../core/services/theme.service';
import { ToastService } from '../../core/services/toast.service';
import { ModelsService } from '../../core/services/models.service';
import { ModelProvider } from '../../core/models/model.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { SwitchComponent } from '../../shared/components/switch/switch.component';
import { BadgeComponent } from '../../shared/components/badge/badge.component';
import { ThemeToggleComponent } from '../../shared/components/theme-toggle/theme-toggle.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';

interface Integration {
  name: string;
  description: string;
  icon: string;
}

interface ModelProviderCard {
  provider: ModelProvider;
  name: string;
  description: string;
  icon: string;
}

function hourToTime(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function timeToHour(time: string): number {
  const hour = parseInt(time.split(':')[0], 10);
  return isNaN(hour) ? 0 : Math.min(23, Math.max(0, hour));
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CardComponent,
    InputComponent,
    ButtonComponent,
    SwitchComponent,
    BadgeComponent,
    ThemeToggleComponent,
    SelectComponent
  ],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss'
})
export class SettingsComponent implements OnInit {
  currentUser = computed(() => this.authService.currentUser());

  dailySendCap = 200;
  quietHoursStart = '20:00';
  quietHoursEnd = '08:00';
  engineActive = true;
  savingGuardrails = false;
  loadingOrg = true;

  integrations: Integration[] = [
    { name: 'Email (Mailgun)', description: 'Send outbound email touches through Mailgun.', icon: 'bi-envelope' },
    { name: 'SMS (Twilio)', description: 'Send and receive SMS follow-ups via Twilio.', icon: 'bi-chat-dots' },
    { name: 'Voice (Vapi)', description: 'Place AI-driven voice calls via Vapi.', icon: 'bi-telephone' },
    { name: 'Search API', description: 'Power the Engine\'s web research for prospecting.', icon: 'bi-search' }
  ];

  modelProviders: ModelProviderCard[] = [
    { provider: 'anthropic', name: 'Anthropic (Claude)', description: 'Powers Claude models for the Engine.', icon: 'bi-stars' },
    { provider: 'openai', name: 'OpenAI', description: 'Powers GPT models for the Engine.', icon: 'bi-cpu' },
    { provider: 'google', name: 'Google Gemini', description: 'Powers Gemini models for the Engine.', icon: 'bi-google' },
    { provider: 'xai', name: 'xAI Grok', description: 'Powers Grok models for the Engine.', icon: 'bi-lightning-charge' },
    { provider: 'deepseek', name: 'DeepSeek', description: 'Powers DeepSeek models for the Engine.', icon: 'bi-search' }
  ];

  // Engine model
  loadingModels = true;
  savingEngineModel = false;
  engineModelSelection: string | null = null;

  engineModelOptions = computed<SelectOption[]>(() =>
    this.modelsService.models().map(model => ({
      label: model.configured ? `${model.label} — ${model.providerLabel}` : `${model.label} — ${model.providerLabel} (not configured)`,
      value: model.id,
      disabled: !model.configured
    }))
  );

  constructor(
    private authService: AuthService,
    private organizationService: OrganizationService,
    public themeService: ThemeService,
    private toast: ToastService,
    private modelsService: ModelsService
  ) {}

  ngOnInit(): void {
    this.organizationService.getMine().subscribe({
      next: org => {
        this.dailySendCap = org.dailySendCap;
        this.quietHoursStart = hourToTime(org.quietHoursStart);
        this.quietHoursEnd = hourToTime(org.quietHoursEnd);
        this.engineActive = !org.paused;
        this.loadingOrg = false;
      },
      error: () => {
        this.loadingOrg = false;
        this.toast.error('Failed to load organization settings');
      }
    });

    this.modelsService.getModels().subscribe({
      next: res => {
        this.engineModelSelection = res.current;
        this.loadingModels = false;
      },
      error: () => {
        this.loadingModels = false;
        this.toast.error('Failed to load Engine models');
      }
    });
  }

  isProviderConfigured(provider: ModelProvider): boolean {
    return this.modelsService.isProviderConfigured(provider);
  }

  saveEngineModel(): void {
    if (!this.engineModelSelection) return;
    const selection = this.engineModelSelection;
    const label = this.modelsService.models().find(m => m.id === selection)?.label ?? selection;

    this.savingEngineModel = true;
    this.modelsService.setModel(selection).subscribe({
      next: () => {
        this.savingEngineModel = false;
        this.toast.success(`Engine model set to ${label}`);
      },
      error: () => {
        this.savingEngineModel = false;
        this.toast.error('Failed to update the Engine model');
      }
    });
  }

  saveGuardrails(): void {
    this.savingGuardrails = true;
    this.organizationService
      .updateMine({
        dailySendCap: Number(this.dailySendCap) || 0,
        quietHoursStart: timeToHour(this.quietHoursStart),
        quietHoursEnd: timeToHour(this.quietHoursEnd)
      })
      .subscribe({
        next: () => {
          this.savingGuardrails = false;
          this.toast.success('Guardrails saved');
        },
        error: () => {
          this.savingGuardrails = false;
          this.toast.error('Failed to save guardrails');
        }
      });
  }

  toggleEngine(): void {
    const next = !this.engineActive;
    this.organizationService.updateMine({ paused: !next }).subscribe({
      next: () => {
        this.engineActive = next;
        this.toast.info(next ? 'Engine resumed' : 'Engine paused — all autonomous actions halted');
      },
      error: () => this.toast.error('Failed to update Engine state')
    });
  }
}
