import { Injectable, computed, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { EngineService } from './engine.service';
import { ToastService } from './toast.service';
import {
  EngineMessage,
  EngineToolEvent,
  RunControlAction,
  RunPhase
} from '../models/engine.model';

/**
 * Owns the state of the Engine conversation and its in-flight run.
 *
 * This lives at the root, not in the Engine component, on purpose: the
 * component is destroyed every time you navigate to Activity/Leads/anywhere,
 * and previously that took the whole conversation and its event stream with it.
 * Holding the state and the stream subscription here means leaving the page
 * just stops rendering — the run keeps going and the thread is intact when you
 * come back. If the browser reloads entirely, openChat() reattaches by asking
 * the server which run is still live for that chat.
 */
@Injectable({ providedIn: 'root' })
export class EngineSessionService {
  private engineService = inject(EngineService);
  private toast = inject(ToastService);

  readonly activeChatId = signal<string | null>(null);
  readonly messages = signal<EngineMessage[]>([]);
  readonly loadingMessages = signal(false);

  readonly runId = signal<string | null>(null);
  readonly phase = signal<RunPhase | null>(null);
  readonly watch = signal(false);
  readonly currentStep = signal<string | undefined>(undefined);

  /** True while a run is in flight (including paused/parked). */
  readonly running = computed(() => {
    const phase = this.phase();
    return phase !== null && phase !== 'finished';
  });

  /** Parked in watch mode, waiting for the operator to advance it. */
  readonly awaitingStep = computed(() => this.phase() === 'awaiting_step');
  readonly paused = computed(() => this.phase() === 'paused');

  private streamSub?: Subscription;
  /** Highest event index applied, so a reconnect resumes rather than repeats. */
  private lastIndex = -1;
  private streamingMessageId: string | null = null;

  // --- Conversation ------------------------------------------------------

  openChat(chatId: string, force = false): void {
    if (!force && this.activeChatId() === chatId && this.messages().length) return;

    this.activeChatId.set(chatId);
    this.loadingMessages.set(true);
    this.engineService.getChat(chatId).subscribe({
      next: (chat) => {
        this.messages.set(chat.messages ?? []);
        this.loadingMessages.set(false);
        this.reattachIfLive(chatId);
      },
      error: () => this.loadingMessages.set(false)
    });
  }

  startNewChat(): void {
    this.detach();
    this.activeChatId.set(null);
    this.messages.set([]);
    this.resetRunState();
  }

  /** After a hard reload, pick the conversation's run back up mid-flight. */
  private reattachIfLive(chatId: string): void {
    if (this.runId()) return;
    this.engineService.liveRunForChat(chatId).subscribe({
      next: (live) => {
        if (!live) return;
        // Rebuild the streaming bubble the events will flow into.
        this.appendStreamingAssistant();
        this.attach(live.runId, 0);
      },
      error: () => undefined
    });
  }

  // --- Running -----------------------------------------------------------

  send(chatId: string, content: string, watch = false): void {
    this.messages.update((list) => [
      ...list,
      { id: `local-${Date.now()}`, role: 'user', content, createdAt: new Date().toISOString() }
    ]);
    this.appendStreamingAssistant();
    this.phase.set('running');
    this.watch.set(watch);

    this.engineService.startRun(chatId, content, watch).subscribe({
      next: ({ runId }) => this.attach(runId, 0),
      error: (err) => {
        this.finishStreamingMessage('The Engine could not start this run.');
        this.resetRunState();
        this.toast.error(err?.error?.error?.message || 'Failed to start the run');
      }
    });
  }

  /** Subscribe to a run's stream, resuming from `fromIndex`. */
  attach(runId: string, fromIndex: number): void {
    this.detach();
    this.runId.set(runId);
    this.lastIndex = fromIndex - 1;
    if (!this.streamingMessageId) this.appendStreamingAssistant();

    this.streamSub = this.engineService.streamRun(runId, fromIndex).subscribe({
      next: ({ index, event }) => {
        // Replay and live-tail can overlap; ignore anything already applied.
        if (index <= this.lastIndex) return;
        this.lastIndex = index;

        switch (event.type) {
          case 'text':
            this.updateStreaming((msg) => ({ ...msg, content: (msg.content || '') + event.delta }));
            break;
          case 'tool_call':
            this.updateStreaming((msg) => ({
              ...msg,
              toolEvents: [...(msg.toolEvents || []), { toolName: event.toolName, input: event.input }]
            }));
            break;
          case 'tool_result':
            this.updateStreaming((msg) => {
              const toolEvents = [...(msg.toolEvents || [])];
              for (let i = toolEvents.length - 1; i >= 0; i--) {
                if (toolEvents[i].toolName === event.toolName && !toolEvents[i].summary) {
                  toolEvents[i] = { ...toolEvents[i], summary: event.summary };
                  break;
                }
              }
              return { ...msg, toolEvents };
            });
            break;
          case 'run_status':
            this.phase.set(event.phase);
            this.watch.set(event.watch);
            this.currentStep.set(event.currentStep);
            if (event.phase === 'finished') this.finishStreamingMessage();
            break;
          case 'error':
            this.finishStreamingMessage(event.message);
            this.resetRunState();
            break;
          case 'done':
            this.finishStreamingMessage();
            this.resetRunState();
            break;
        }
      },
      error: () => {
        // Dropped connection: the run is probably still going server-side, so
        // resume from where we stopped rather than restarting the thread.
        const id = this.runId();
        if (id) setTimeout(() => this.attach(id, this.lastIndex + 1), 1500);
      }
    });
  }

  /** Stop rendering this run locally without touching the run itself. */
  detach(): void {
    this.streamSub?.unsubscribe();
    this.streamSub = undefined;
  }

  control(action: RunControlAction): void {
    const runId = this.runId();
    if (!runId) return;
    // Reflect intent immediately; the stream corrects it a moment later.
    if (action === 'watch_on') this.watch.set(true);
    if (action === 'watch_off') this.watch.set(false);

    this.engineService.control(runId, action).subscribe({
      next: () => {
        if (action === 'cancel') this.toast.info('Stopping after the current step finishes');
      },
      error: () => this.toast.error(`Could not ${action.replace('_', ' ')} this run`)
    });
  }

  // --- Message plumbing --------------------------------------------------

  private appendStreamingAssistant(): void {
    const id = `streaming-${Date.now()}`;
    this.streamingMessageId = id;
    this.messages.update((list) => [
      ...list,
      { id, role: 'assistant', content: '', createdAt: new Date().toISOString(), toolEvents: [], streaming: true }
    ]);
  }

  private updateStreaming(fn: (msg: EngineMessage) => EngineMessage): void {
    const id = this.streamingMessageId;
    if (!id) return;
    this.messages.update((list) => {
      const idx = list.findIndex((m) => m.id === id);
      if (idx === -1) return list;
      const next = [...list];
      next[idx] = fn(next[idx]);
      return next;
    });
  }

  private finishStreamingMessage(fallback?: string): void {
    this.updateStreaming((msg) => ({
      ...msg,
      streaming: false,
      content: msg.content || fallback || msg.content
    }));
    this.streamingMessageId = null;
  }

  private resetRunState(): void {
    this.detach();
    this.runId.set(null);
    this.phase.set(null);
    this.currentStep.set(undefined);
    this.watch.set(false);
  }

  /** Adopt a run started elsewhere (e.g. clicked from the fleet view). */
  adopt(runId: string, chatId?: string): void {
    if (chatId) this.openChat(chatId, true);
    this.attach(runId, 0);
  }

  toolEventLabel(event: EngineToolEvent): string {
    return event.toolName.replace(/_/g, ' ');
  }
}
