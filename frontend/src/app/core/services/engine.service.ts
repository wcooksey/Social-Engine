import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import {
  ActiveRun,
  EngineChat,
  EngineChatSummary,
  IndexedStreamEvent,
  RunControlAction
} from '../models/engine.model';

@Injectable({ providedIn: 'root' })
export class EngineService {
  private api = inject(ApiService);
  private authService = inject(AuthService);

  /**
   * `playbookId` narrows the list to one line of business; pass 'none' for the
   * conversations that haven't been filed anywhere yet.
   */
  listChats(playbookId?: string | null): Observable<EngineChatSummary[]> {
    return this.api.get<EngineChatSummary[]>('/api/engine/chats', { playbookId });
  }

  createChat(playbookId?: string | null): Observable<EngineChatSummary> {
    return this.api.post<EngineChatSummary>('/api/engine/chats', { playbookId: playbookId ?? null });
  }

  /** File a conversation under a playbook, or pass null to unfile it. */
  setChatPlaybook(chatId: string, playbookId: string | null): Observable<EngineChatSummary> {
    return this.api.patch<EngineChatSummary>(`/api/engine/chats/${chatId}`, { playbookId });
  }

  getChat(id: string): Observable<EngineChat> {
    return this.api.get<EngineChat>(`/api/engine/chats/${id}`);
  }

  deleteChat(id: string): Observable<void> {
    return this.api.delete<void>(`/api/engine/chats/${id}`);
  }

  /**
   * Start a run. Returns as soon as the run exists — the run itself continues
   * server-side, followed via streamRun(). Nothing about it dies with this
   * request or with the page.
   */
  startRun(chatId: string, content: string, watch = false): Observable<{ runId: string }> {
    return this.api.post<{ runId: string }>(`/api/engine/chats/${chatId}/messages`, { content, watch });
  }

  /** The live run for a chat, if one is still going — used to reattach. */
  liveRunForChat(chatId: string): Observable<ActiveRun | null> {
    return this.api.get<ActiveRun | null>(`/api/engine/chats/${chatId}/live`);
  }

  /** Every run in flight for the org — the fleet view. */
  activeRuns(): Observable<ActiveRun[]> {
    return this.api.get<ActiveRun[]>('/api/engine/runs/active');
  }

  control(runId: string, action: RunControlAction): Observable<unknown> {
    return this.api.post(`/api/engine/runs/${runId}/control`, { action });
  }

  /**
   * Attach to a run's event stream, resuming from `fromIndex` so a reconnect
   * replays only what was missed. Uses fetch() + a ReadableStream reader rather
   * than EventSource so the request can carry an Authorization header.
   */
  streamRun(runId: string, fromIndex = 0): Observable<IndexedStreamEvent> {
    return new Observable<IndexedStreamEvent>(subscriber => {
      const controller = new AbortController();

      (async () => {
        try {
          const response = await fetch(
            this.api.url(`/api/engine/runs/${runId}/stream?fromIndex=${fromIndex}`),
            {
              headers: {
                Accept: 'text/event-stream',
                ...(this.authService.token ? { Authorization: `Bearer ${this.authService.token}` } : {})
              },
              signal: controller.signal
            }
          );

          if (!response.ok || !response.body) {
            throw new Error(`Engine stream failed with status ${response.status}`);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';

            for (const part of parts) {
              const line = part.trim();
              if (!line.startsWith('data:')) continue;
              const jsonStr = line.slice(5).trim();
              if (!jsonStr) continue;
              try {
                subscriber.next(JSON.parse(jsonStr) as IndexedStreamEvent);
              } catch {
                // Ignore malformed chunks rather than killing the stream.
              }
            }
          }

          subscriber.complete();
        } catch (err) {
          if ((err as any)?.name !== 'AbortError') {
            subscriber.error(err);
          } else {
            subscriber.complete();
          }
        }
      })();

      return () => controller.abort();
    });
  }
}
