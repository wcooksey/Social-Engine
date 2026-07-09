import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { ApiService } from './api.service';
import { ModelOption, ModelProvider, ModelsResponse } from '../models/model.model';

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
    return this._models().find(m => m.id === id) ?? null;
  });

  getModels(): Observable<ModelsResponse> {
    return this.api.get<ModelsResponse>('/api/models').pipe(
      tap(res => {
        this._models.set(res.models);
        this._currentModel.set(res.current);
        this._loaded.set(true);
      })
    );
  }

  setModel(id: string): Observable<unknown> {
    return this.api.patch('/api/organizations/mine', { engineModel: id }).pipe(
      tap(() => this._currentModel.set(id))
    );
  }

  /** Whether a given provider currently has a configured (usable) model. */
  isProviderConfigured(provider: ModelProvider): boolean {
    return this._models().some(m => m.provider === provider && m.configured);
  }
}
