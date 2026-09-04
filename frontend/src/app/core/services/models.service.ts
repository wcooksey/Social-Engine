import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ApiService } from './api.service';
import { ModelOption, ModelProvider, ModelsResponse } from '../models/model.model';

/** Best-effort provider inference from a model id prefix (for uncatalogued ids). */
function providerFromId(id: string): ModelProvider {
  const s = id.toLowerCase();
  if (s.startsWith('claude-')) return 'anthropic';
  if (s.startsWith('gpt-') || s.startsWith('o1') || s.startsWith('o3') || s.startsWith('o4')) return 'openai';
  if (s.startsWith('gemini-')) return 'google';
  if (s.startsWith('grok-')) return 'xai';
  if (s.startsWith('deepseek-')) return 'deepseek';
  if (s.startsWith('kimi-') || s.startsWith('moonshot-')) return 'moonshot';
  return 'anthropic';
}

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot (Kimi)',
};

function providerLabelFromId(id: string): string {
  return PROVIDER_LABELS[providerFromId(id)];
}

/**
 * AI model catalog for the Engine, plus the org's currently active model.
 * `currentModel` is kept in sync locally after every load/set so the rest of
 * the app (engine header, settings) can read it as a signal without refetching.
 */
@Injectable({ providedIn: 'root' })
export class ModelsService {
  private api = inject(ApiService);

  private readonly _models = signal<ModelOption[]>([]);
  readonly models = this._models.asReadonly();

  private readonly _currentModel = signal<string | null>(null);
  readonly currentModel = this._currentModel.asReadonly();

  private readonly _loaded = signal(false);
  readonly loaded = this._loaded.asReadonly();

  /** The full ModelOption for whichever model id is currently active. */
  readonly currentModelOption = computed<ModelOption | null>(() => {
    const id = this._currentModel();
    if (!id) return null;
    const found = this._models().find(m => m.id === id);
    if (found) return found;
    // The saved model isn't in the current catalog (e.g. a deprecated id saved
    // before a model upgrade). Synthesize a display option from the id so the
    // picker shows the real value instead of dead-ending on "Select model".
    return {
      id,
      label: id,
      provider: providerFromId(id),
      providerLabel: providerLabelFromId(id),
      configured: false,
    };
  });

  /**
   * Options for a <select>: the catalog plus, if the active model was dropped
   * from the catalog, a synthetic entry so the current value stays selectable.
   */
  readonly modelOptionsWithCurrent = computed<ModelOption[]>(() => {
    const models = this._models();
    const current = this.currentModelOption();
    if (current && !models.some(m => m.id === current.id)) {
      return [current, ...models];
    }
    return models;
  });

  private readonly _coachModel = signal<string | null>(null);
  /** The call coach's model. Follows the Engine's until set explicitly. */
  readonly coachModel = this._coachModel.asReadonly();

  private readonly _coachIsInherited = signal(true);
  readonly coachIsInherited = this._coachIsInherited.asReadonly();

  getModels(): Observable<ModelsResponse> {
    return this.api.get<ModelsResponse>('/api/models').pipe(
      tap(res => {
        this._models.set(res.models);
        this._currentModel.set(res.current);
        this._coachModel.set(res.coachCurrent ?? res.current);
        this._coachIsInherited.set(res.coachIsInherited ?? true);
        this._loaded.set(true);
      })
    );
  }

  setModel(id: string): Observable<{ engineModel?: string | null } | unknown> {
    return this.api.patch<{ engineModel?: string | null }>('/api/organizations/mine', { engineModel: id }).pipe(
      // Trust the value the server actually stored, not just what we sent.
      tap(org => {
        this._currentModel.set((org && org.engineModel) || id);
        // A coach that hasn't been pinned follows the Engine, so keep it in step.
        if (this._coachIsInherited()) this._coachModel.set((org && org.engineModel) || id);
      })
    );
  }

  /** Pin the coach to its own model, independent of whatever the Engine runs on. */
  setCoachModel(id: string): Observable<{ coachModel?: string | null } | unknown> {
    return this.api.patch<{ coachModel?: string | null }>('/api/organizations/mine', { coachModel: id }).pipe(
      tap(org => {
        this._coachModel.set((org && org.coachModel) || id);
        this._coachIsInherited.set(false);
      })
    );
  }

  /** Whether a given provider currently has a configured (usable) model. */
  isProviderConfigured(provider: ModelProvider): boolean {
    return this._models().some(m => m.provider === provider && m.configured);
  }
}
