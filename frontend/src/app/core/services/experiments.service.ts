import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { Experiment, ExperimentChannel, ExperimentStatus } from '../models/experiment.model';

export interface ExperimentVariantInput {
  label: string;
  content: string;
  weight?: number;
}

export interface ExperimentInput {
  name: string;
  channel: ExperimentChannel;
  goal?: string;
  variants: ExperimentVariantInput[];
}

export interface ExperimentPatch {
  name?: string;
  goal?: string;
  status?: ExperimentStatus;
  winnerVariantId?: string;
}

@Injectable({ providedIn: 'root' })
export class ExperimentsService {
  private api = inject(ApiService);

  list(): Observable<Experiment[]> {
    return this.api.get<Experiment[]>('/api/experiments');
  }

  get(id: string): Observable<Experiment> {
    return this.api.get<Experiment>(`/api/experiments/${id}`);
  }

  create(input: ExperimentInput): Observable<Experiment> {
    return this.api.post<Experiment>('/api/experiments', input);
  }

  update(id: string, patch: ExperimentPatch): Observable<Experiment> {
    return this.api.patch<Experiment>(`/api/experiments/${id}`, patch);
  }
}
