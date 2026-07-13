import { Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { EngineService } from '../../core/services/engine.service';
import { EngineChatSummary, EngineMessage, EngineToolEvent } from '../../core/models/engine.model';
import { ToastService } from '../../core/services/toast.service';
import { VoiceService } from '../../core/services/voice.service';
import { VoiceAgentEvent, VoiceAgentService } from '../../core/services/voice-agent.service';
import { ModelPickerComponent } from './model-picker/model-picker.component';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe';
import { ChatAmbientComponent } from '../../shared/components/chat-ambient/chat-ambient.component';

@Component({
  selector: 'app-engine',
  standalone: true,
  imports: [CommonModule, FormsModule, ModelPickerComponent, MarkdownPipe, ChatAmbientComponent],
  templateUrl: './engine.component.html',
  styleUrl: './engine.component.scss'
})
export class EngineComponent implements OnInit, OnDestroy {
  chats = signal<EngineChatSummary[]>([]);
  activeChatId = signal<string | null>(null);
  messages = signal<EngineMessage[]>([]);
  loadingChats = signal(true);
  loadingMessages = signal(false);
  sending = signal(false);

  draft = '';

  /** Snapshot of the draft text captured when the mic was last (re)started. */
  private voiceBaseDraft = '';

  readonly micSupported: boolean;
  readonly ttsSupported: boolean;

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

  /** id of the in-progress assistant bubble built from live voice events. */
  private pendingVoiceMessageId: string | null = null;
  private voiceEventsSub?: Subscription;

  constructor(
    private engineService: EngineService,
    private toast: ToastService,
    protected voiceService: VoiceService,
    protected voiceAgent: VoiceAgentService
  ) {
    this.micSupported = this.voiceService.isSupported();
    this.ttsSupported = this.voiceService.isSpeechSynthesisSupported();
  }

  ngOnInit(): void {
    this.loadChats();
    this.voiceAgent.checkAvailability();
    this.voiceEventsSub = this.voiceAgent.events$.subscribe((event) => this.onVoiceAgentEvent(event));
  }

  ngOnDestroy(): void {
    this.voiceEventsSub?.unsubscribe();
    void this.voiceAgent.stop();
    this.voiceService.stopListening();
    this.voiceService.cancelSpeech();
  }

  // --- Live voice mode (ElevenLabs agent) ---------------------------------

  async toggleVoiceAgent(): Promise<void> {
    if (this.voiceAgent.status() === 'active' || this.voiceAgent.status() === 'connecting') {
      await this.voiceAgent.stop();
      return;
    }
    // A voice session is its own conversation — clear the thread for the live transcript.
    this.startNewChat();
    await this.voiceAgent.start();
  }

  private onVoiceAgentEvent(event: VoiceAgentEvent): void {
    switch (event.type) {
      case 'user':
        this.pendingVoiceMessageId = null;
        this.messages.update((list) => [
          ...list,
          { id: `voice-user-${Date.now()}`, role: 'user', content: event.text, createdAt: new Date().toISOString() },
        ]);
        break;
      case 'agent': {
        const pendingId = this.pendingVoiceMessageId;
        this.pendingVoiceMessageId = null;
        this.messages.update((list) => {
          const idx = pendingId ? list.findIndex((m) => m.id === pendingId) : -1;
          if (idx !== -1) {
            const next = [...list];
            next[idx] = { ...next[idx], content: event.text, streaming: false };
            return next;
          }
          return [
            ...list,
            { id: `voice-agent-${Date.now()}`, role: 'assistant', content: event.text, createdAt: new Date().toISOString() },
          ];
        });
        break;
      }
      case 'tool': {
        const toolEvent: EngineToolEvent = { toolName: event.toolName, input: event.input };
        this.messages.update((list) => {
          const idx = this.pendingVoiceMessageId
            ? list.findIndex((m) => m.id === this.pendingVoiceMessageId)
            : -1;
          if (idx !== -1) {
            const next = [...list];
            next[idx] = { ...next[idx], toolEvents: [...(next[idx].toolEvents || []), toolEvent] };
            return next;
          }
          const id = `voice-tools-${Date.now()}`;
          this.pendingVoiceMessageId = id;
          return [
            ...list,
            { id, role: 'assistant', content: '', createdAt: new Date().toISOString(), toolEvents: [toolEvent], streaming: true },
          ];
        });
        break;
      }
      case 'tool_done':
        this.messages.update((list) => {
          const idx = this.pendingVoiceMessageId
            ? list.findIndex((m) => m.id === this.pendingVoiceMessageId)
            : -1;
          if (idx === -1) return list;
          const toolEvents = [...(list[idx].toolEvents || [])];
          for (let i = toolEvents.length - 1; i >= 0; i--) {
            if (toolEvents[i].toolName === event.toolName && !toolEvents[i].summary) {
              toolEvents[i] = {
                ...toolEvents[i],
                summary: `${event.toolName} — ${event.isError ? 'failed' : 'done'}`,
              };
              break;
            }
          }
          const next = [...list];
          next[idx] = { ...next[idx], toolEvents };
          return next;
        });
        break;
      case 'ended':
        this.pendingVoiceMessageId = null;
        this.loadChats();
        break;
      case 'error':
        this.toast.error(event.message || 'Voice session error');
        break;
    }
    this.scrollToBottom();
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

  toggleMic(): void {
    if (!this.micSupported) {
      this.toast.warning('Voice input not supported in this browser');
      return;
    }

    if (this.voiceService.listening()) {
      this.voiceService.stopListening();
      return;
    }

    this.voiceBaseDraft = this.draft;
    this.voiceService.startListening(
      (interimText) => {
        this.draft = this.appendTranscript(this.voiceBaseDraft, interimText);
      },
      (finalText) => {
        this.voiceBaseDraft = this.appendTranscript(this.voiceBaseDraft, finalText);
        this.draft = this.voiceBaseDraft;
      },
      () => {
        this.textareaRef?.nativeElement.focus();
      }
    );
  }

  toggleTts(): void {
    if (!this.ttsSupported) {
      this.toast.warning('Spoken replies are not supported in this browser');
      return;
    }
    this.voiceService.toggleTts();
    if (!this.voiceService.ttsEnabled()) {
      this.voiceService.cancelSpeech();
    }
  }

  private appendTranscript(base: string, segment: string): string {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) return base;
    if (!base) return trimmedSegment;
    return base.endsWith(' ') ? `${base}${trimmedSegment}` : `${base} ${trimmedSegment}`;
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
        let finishedAssistantText: string | null = null;

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
            case 'model_failover': {
              const toolEvents = [...(msg.toolEvents || [])];
              toolEvents.push({
                toolName: 'model failover',
                summary: `${event.fromModel} unavailable — continuing on ${event.toModel}`
              });
              msg.toolEvents = toolEvents;
              this.toast.info(`Provider issue — Engine switched to ${event.toModel} for this run`);
              break;
            }
            case 'done':
              msg.streaming = false;
              msg.agentRunId = event.runId;
              msg.id = event.messageId;
              finishedAssistantText = msg.content;
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

        if (finishedAssistantText && this.voiceService.ttsEnabled()) {
          this.voiceService.speak(finishedAssistantText);
        }
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
