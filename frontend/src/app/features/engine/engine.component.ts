import { Component, ElementRef, OnInit, ViewChild, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EngineService } from '../../core/services/engine.service';
import { EngineChatSummary, EngineMessage, EngineToolEvent } from '../../core/models/engine.model';
import { ToastService } from '../../core/services/toast.service';
import { ModelPickerComponent } from './model-picker/model-picker.component';

@Component({
  selector: 'app-engine',
  standalone: true,
  imports: [CommonModule, FormsModule, ModelPickerComponent],
  templateUrl: './engine.component.html',
  styleUrl: './engine.component.scss'
})
export class EngineComponent implements OnInit {
  chats = signal<EngineChatSummary[]>([]);
  activeChatId = signal<string | null>(null);
  messages = signal<EngineMessage[]>([]);
  loadingChats = signal(true);
  loadingMessages = signal(false);
  sending = signal(false);

  draft = '';

  examplePrompts = [
    'Build a list of every automotive dealership in Florida',
    'Follow up with everyone in the Florida group',
    'Find plumbing companies in Austin with 10+ reviews and no website chat widget',
    'Draft a campaign offering a free audit to interested leads'
  ];

  @ViewChild('threadEnd') threadEnd?: ElementRef<HTMLDivElement>;
  @ViewChild('textarea') textareaRef?: ElementRef<HTMLTextAreaElement>;

  activeChatTitle = computed(() => {
    const id = this.activeChatId();
    if (!id) return 'Engine';
    return this.chats().find(c => c.id === id)?.title || 'New conversation';
  });

  constructor(private engineService: EngineService, private toast: ToastService) {}

  ngOnInit(): void {
    this.loadChats();
  }

  loadChats(): void {
    this.loadingChats.set(true);
    this.engineService.listChats().subscribe({
      next: (chats) => {
        this.chats.set(chats);
        this.loadingChats.set(false);
      },
      error: () => this.loadingChats.set(false)
    });
  }

  selectChat(chat: EngineChatSummary): void {
    if (this.sending()) return;
    this.activeChatId.set(chat.id);
    this.loadingMessages.set(true);
    this.messages.set([]);
    this.engineService.getChat(chat.id).subscribe({
      next: (full) => {
        this.messages.set(full.messages);
        this.loadingMessages.set(false);
        this.scrollToBottom();
      },
      error: () => this.loadingMessages.set(false)
    });
  }

  startNewChat(): void {
    if (this.sending()) return;
    this.activeChatId.set(null);
    this.messages.set([]);
    this.draft = '';
  }

  useExamplePrompt(prompt: string): void {
    this.draft = prompt;
    this.textareaRef?.nativeElement.focus();
  }

  handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  send(): void {
    const content = this.draft.trim();
    if (!content || this.sending()) return;
    this.draft = '';

    if (!this.activeChatId()) {
      this.engineService.createChat().subscribe({
        next: (chat) => {
          this.chats.update(list => [chat, ...list]);
          this.activeChatId.set(chat.id);
          this.streamMessage(chat.id, content);
        },
        error: () => this.toast.error('Failed to start a new chat')
      });
    } else {
      this.streamMessage(this.activeChatId()!, content);
    }
  }

  private streamMessage(chatId: string, content: string): void {
    const userMessage: EngineMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      content,
      createdAt: new Date().toISOString()
    };

    const assistantMessage: EngineMessage = {
      id: `streaming-${Date.now()}`,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      toolEvents: [],
      streaming: true
    };

    this.messages.update(list => [...list, userMessage, assistantMessage]);
    this.sending.set(true);
    this.scrollToBottom();

    this.engineService.sendMessage(chatId, content).subscribe({
      next: (event) => {
        this.messages.update(list => {
          const idx = list.findIndex(m => m.id === assistantMessage.id);
          if (idx === -1) return list;
          const msg = { ...list[idx] };

          switch (event.type) {
            case 'text':
              msg.content = (msg.content || '') + event.delta;
              break;
            case 'tool_call': {
              const toolEvents: EngineToolEvent[] = [...(msg.toolEvents || [])];
              toolEvents.push({ toolName: event.toolName, input: event.input });
              msg.toolEvents = toolEvents;
              break;
            }
            case 'tool_result': {
              const toolEvents = [...(msg.toolEvents || [])];
              for (let i = toolEvents.length - 1; i >= 0; i--) {
                if (toolEvents[i].toolName === event.toolName && !toolEvents[i].summary) {
                  toolEvents[i] = { ...toolEvents[i], summary: event.summary };
                  break;
                }
              }
              msg.toolEvents = toolEvents;
              break;
            }
            case 'done':
              msg.streaming = false;
              msg.agentRunId = event.runId;
              msg.id = event.messageId;
              break;
            case 'error':
              msg.streaming = false;
              msg.content = msg.content || `Something went wrong: ${event.message}`;
              break;
          }

          const next = [...list];
          next[idx] = msg;
          return next;
        });
        this.scrollToBottom();
      },
      error: () => {
        this.sending.set(false);
        this.messages.update(list => {
          const idx = list.findIndex(m => m.id === assistantMessage.id);
          if (idx === -1) return list;
          const next = [...list];
          next[idx] = { ...next[idx], streaming: false, content: next[idx].content || 'The Engine ran into an error. Please try again.' };
          return next;
        });
        this.toast.error('Lost connection to the Engine');
      },
      complete: () => {
        this.sending.set(false);
        this.loadChats();
      }
    });
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      this.threadEnd?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 0);
  }

  toolIcon(toolName: string): string {
    const map: Record<string, string> = {
      search_web: 'bi-search',
      upsert_lead: 'bi-building-add',
      create_lead_group: 'bi-collection',
      send_email: 'bi-envelope',
      send_sms: 'bi-chat-dots',
      place_call: 'bi-telephone',
      schedule_followup: 'bi-clock-history'
    };
    return map[toolName] || 'bi-gear';
  }

  toolLabel(event: EngineToolEvent): string {
    if (event.summary) return event.summary;
    const input = event.input as Record<string, unknown> | undefined;
    const detail = input?.['companyName'] || input?.['name'] || input?.['query'];
    return detail ? `${event.toolName} — ${detail}` : event.toolName;
  }

  trackByMessageId(index: number, message: EngineMessage): string {
    return message.id;
  }

  trackByChatId(index: number, chat: EngineChatSummary): string {
    return chat.id;
  }
}
