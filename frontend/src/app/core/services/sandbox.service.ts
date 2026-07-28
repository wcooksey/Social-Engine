import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export type SandboxChannel = 'EMAIL' | 'SMS' | 'FACEBOOK' | 'INSTAGRAM' | 'LINKEDIN';

export interface SandboxAction {
  toolName: string;
  input?: unknown;
  simulated: boolean;
}

export interface SandboxReply {
  runId: string;
  channel: SandboxChannel;
  leadName?: string | null;
  reply: string;
  /** What it WOULD have done — the part worth tuning. */
  actions: SandboxAction[];
  error?: string;
  note: string;
}

export interface SandboxCallResult {
  placed: boolean;
  to: string;
  vapiCallId?: string;
  usedVoicePlaybooks: boolean;
  systemPrompt: string;
  note: string;
}

/** Rehearsal APIs: exercise the real AI behaviour without touching a prospect. */
@Injectable({ providedIn: 'root' })
export class SandboxService {
  private api = inject(ApiService);

  reply(input: {
    channel: SandboxChannel;
    message: string;
    leadId?: string;
    history: { role: 'user' | 'assistant'; content: string }[];
  }): Observable<SandboxReply> {
    return this.api.post<SandboxReply>('/api/sandbox/reply', input);
  }

  callPrompt(leadId?: string, objective?: string): Observable<{ systemPrompt: string; hasVoicePlaybooks: boolean }> {
    return this.api.get<{ systemPrompt: string; hasVoicePlaybooks: boolean }>('/api/sandbox/call-prompt', {
      ...(leadId ? { leadId } : {}),
      ...(objective ? { objective } : {})
    });
  }

  callMe(input: { to: string; leadId?: string; objective?: string; firstMessage?: string }): Observable<SandboxCallResult> {
    return this.api.post<SandboxCallResult>('/api/sandbox/call-me', input);
  }
}
