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
  capabilities?: CallCapabilities;
  midCallActions?: string;
  note: string;
}

export interface CallCapabilities {
  canText: boolean;
  canBook: boolean;
}

export interface CoachPlaybook {
  id: string;
  name: string;
  scopeLabel: string;
  channel: string;
  instructions: string;
  priority: number;
}

export interface CoachOutcomeStat {
  outcome: string;
  label: string;
  count: number;
  share: number;
}

export interface CoachContext {
  callPrompt: string;
  voicePlaybooks: CoachPlaybook[];
  outcomes: CoachOutcomeStat[];
  totalCalls: number;
  recentCalls: { outcome: string; summary: string; at: string }[];
  capabilities: CallCapabilities;
  model: string;
  modelIsInherited: boolean;
}

/** A playbook the coach wrote. Not active until you apply it. */
export interface CoachProposal {
  playbookId?: string;
  replaces?: { name: string; instructions: string };
  name: string;
  instructions: string;
  rationale: string;
}

export interface CoachTurn {
  reply: string;
  proposals: CoachProposal[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
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

  // --- Call coach ---------------------------------------------------------

  coachContext(): Observable<CoachContext> {
    return this.api.get<CoachContext>('/api/sandbox/coach/context');
  }

  coach(input: {
    messages: { role: 'user' | 'assistant'; content: string }[];
    model?: string;
  }): Observable<CoachTurn> {
    return this.api.post<CoachTurn>('/api/sandbox/coach', input);
  }

  applyProposal(input: {
    playbookId?: string;
    name: string;
    instructions: string;
  }): Observable<{ playbookId: string; created: boolean; note: string }> {
    return this.api.post<{ playbookId: string; created: boolean; note: string }>(
      '/api/sandbox/coach/apply',
      input
    );
  }
}
