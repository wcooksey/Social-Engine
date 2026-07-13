import { Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { Conversation } from '@elevenlabs/client';
import { ApiService } from './api.service';

export type VoiceAgentStatus = 'idle' | 'connecting' | 'active';

export type VoiceAgentEvent =
  | { type: 'user'; text: string }
  | { type: 'agent'; text: string }
  | { type: 'tool'; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_done'; toolName: string; isError: boolean }
  | { type: 'ended'; chatId: string | null }
  | { type: 'error'; message: string };

interface VoiceSession {
  signedUrl: string;
  runId: string;
  toolNames: string[];
}

/**
 * Live voice mode for the Engine, powered by ElevenLabs Agents. The
 * conversation (mic capture, turn-taking, agent speech) runs directly between
 * the browser and ElevenLabs over a signed WebSocket; the agent's tool calls
 * are forwarded to our backend, which executes them with the user's auth and
 * org scoping.
 */
@Injectable({ providedIn: 'root' })
export class VoiceAgentService {
  private api = inject(ApiService);

  /** Whether ElevenLabs is configured for this org (null = not checked yet). */
  readonly available = signal<boolean | null>(null);
  readonly status = signal<VoiceAgentStatus>('idle');
  /** Who is talking right now, while a session is active. */
  readonly mode = signal<'listening' | 'speaking'>('listening');

  readonly events$ = new Subject<VoiceAgentEvent>();

  private conversation: Conversation | null = null;
  private runId: string | null = null;
  private transcript: { role: 'user' | 'assistant'; content: string }[] = [];

  checkAvailability(): void {
    this.api.get<{ available: boolean }>('/api/voice/status').subscribe({
      next: (res) => this.available.set(res.available),
      error: () => this.available.set(false),
    });
  }

  async start(): Promise<void> {
    if (this.status() !== 'idle') return;
    this.status.set('connecting');
    this.transcript = [];

    try {
      const session = await firstValueFrom(this.api.post<VoiceSession>('/api/voice/session', {}));
      this.runId = session.runId;

      const clientTools: Record<string, (parameters: any) => Promise<string>> = {};
      for (const name of session.toolNames) {
        clientTools[name] = (parameters: any) => this.executeTool(session.runId, name, parameters);
      }

      this.conversation = await Conversation.startSession({
        signedUrl: session.signedUrl,
        connectionType: 'websocket',
        clientTools,
        onConnect: () => this.status.set('active'),
        onDisconnect: (details) => {
          if (details.reason === 'error') {
            this.events$.next({ type: 'error', message: details.message });
          }
          void this.finishSession();
        },
        onModeChange: ({ mode }) => this.mode.set(mode),
        onMessage: ({ message, role }) => {
          const r = role === 'user' ? 'user' : 'assistant';
          this.transcript.push({ role: r, content: message });
          this.events$.next({ type: r === 'user' ? 'user' : 'agent', text: message });
        },
        onError: (message) => this.events$.next({ type: 'error', message }),
      });
    } catch (err) {
      this.status.set('idle');
      const message =
        (err as any)?.error?.error ||
        (err instanceof Error ? err.message : 'Could not start the voice session');
      this.events$.next({ type: 'error', message });
      this.runId = null;
    }
  }

  /** End the session from the UI side. Safe to call unconditionally. */
  async stop(): Promise<void> {
    const conversation = this.conversation;
    this.conversation = null;
    if (conversation) {
      try {
        await conversation.endSession();
      } catch {
        // Socket may already be closed — finishSession below still runs.
      }
    }
    await this.finishSession();
  }

  private async executeTool(runId: string, name: string, parameters: any): Promise<string> {
    this.events$.next({ type: 'tool', toolName: name, input: parameters ?? {} });
    try {
      const res = await firstValueFrom(
        this.api.post<{ result: unknown; isError: boolean }>(`/api/voice/session/${runId}/tool`, {
          name,
          input: parameters ?? {},
        })
      );
      this.events$.next({ type: 'tool_done', toolName: name, isError: res.isError });
      return JSON.stringify(res.result ?? null);
    } catch (err) {
      this.events$.next({ type: 'tool_done', toolName: name, isError: true });
      return JSON.stringify({
        error: err instanceof Error ? err.message : 'Tool execution failed',
      });
    }
  }

  /** Close out the backend run + persist the transcript. Idempotent. */
  private async finishSession(): Promise<void> {
    const runId = this.runId;
    this.runId = null;
    this.conversation = null;
    this.status.set('idle');
    this.mode.set('listening');
    if (!runId) return;

    try {
      const res = await firstValueFrom(
        this.api.post<{ chatId: string | null }>(`/api/voice/session/${runId}/end`, {
          transcript: this.transcript,
        })
      );
      this.events$.next({ type: 'ended', chatId: res.chatId });
    } catch {
      this.events$.next({ type: 'ended', chatId: null });
    }
    this.transcript = [];
  }
}
