import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { EngineChat, EngineChatSummary, EngineStreamEvent } from '../models/engine.model';

@Injectable({ providedIn: 'root' })
export class EngineService {
  private api = inject(ApiService);
  private authService = inject(AuthService);

  listChats(): Observable<EngineChatSummary[]> {
    return this.api.get<EngineChatSummary[]>('/api/engine/chats');
  }

  createChat(): Observable<EngineChatSummary> {
    return this.api.post<EngineChatSummary>('/api/engine/chats', {});
  }

  getChat(id: string): Observable<EngineChat> {
    return this.api.get<EngineChat>(`/api/engine/chats/${id}`);
  }

  /**
   * Streams a reply to a message via Server-Sent Events. Uses fetch() + a
   * ReadableStream reader rather than EventSource because the endpoint is a
   * POST (EventSource only supports GET).
   */
  sendMessage(chatId: string, content: string): Observable<EngineStreamEvent> {
    return new Observable<EngineStreamEvent>(subscriber => {
      const controller = new AbortController();

      (async () => {
        try {
          const response = await fetch(this.api.url(`/api/engine/chats/${chatId}/messages`), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              ...(this.authService.token ? { Authorization: `Bearer ${this.authService.token}` } : {})
            },
            body: JSON.stringify({ content }),
            signal: controller.signal
          });

          if (!response.ok || !response.body) {
            throw new Error(`Engine request failed with status ${response.status}`);
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
                const event = JSON.parse(jsonStr) as EngineStreamEvent;
                subscriber.next(event);
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
