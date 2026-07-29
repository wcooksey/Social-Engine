import { Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { EngineService } from '../../core/services/engine.service';
import { EngineSessionService } from '../../core/services/engine-session.service';
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
  loadingChats = signal(true);

  /**
   * Conversation + run state live in the root-scoped session service, NOT here.
   * This component is destroyed on every navigation; keeping them local is what
   * used to wipe the thread and drop the event stream on the way to Activity.
   */
  activeChatId = this.session.activeChatId;
  messages = this.session.messages;
  loadingMessages = this.session.loadingMessages;
  sending = this.session.running;
  runPhase = this.session.phase;
  watchMode = this.session.watch;
  currentStep = this.session.currentStep;
  awaitingStep = this.session.awaitingStep;
  paused = this.session.paused;

  draft = '';
  /** Start the NEXT run parked, stepping through one action at a time. */
  watchNextRun = false;

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
    protected session: EngineSessionService,
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
    // Coming back to the page: the session service still holds the thread and
    // its stream, so there is nothing to restore — just scroll to where we were.
    if (this.messages().length) this.scrollToBottom();
  }

  ngOnDestroy(): void {
    this.voiceEventsSub?.unsubscribe();
    void this.voiceAgent.stop();
    this.voiceService.stopListening();
    this.voiceService.cancelSpeech();
    // Deliberately NOT detaching the run stream — it belongs to the session
    // service and must survive this component so the run stays followable.
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
    this.session.openChat(chat.id, true);
    this.scrollToBottom();
  }

  startNewChat(): void {
    if (this.sending()) return;
    this.session.startNewChat();
    this.draft = '';
  }

  // --- Run transport ------------------------------------------------------

  pauseRun(): void {
    this.session.control('pause');
  }

  resumeRun(): void {
    this.session.control('resume');
  }

  stepRun(): void {
    this.session.control('step');
  }

  cancelRun(): void {
    this.session.control('cancel');
  }

  /** Toggle watch mode mid-run — parks it at the next action, or releases it. */
  toggleWatch(): void {
    this.session.control(this.watchMode() ? 'watch_off' : 'watch_on');
  }

  runPhaseLabel(): string {
    switch (this.runPhase()) {
      case 'running': return this.currentStep() || 'Working';
      case 'paused': return 'Paused';
      case 'awaiting_step': return `Next: ${this.currentStep() || 'ready'}`;
      case 'cancelling': return 'Stopping after this step';
      default: return '';
    }
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
    const watch = this.watchNextRun;

    if (!this.activeChatId()) {
      this.engineService.createChat().subscribe({
        next: (chat) => {
          this.chats.update(list => [chat, ...list]);
          this.session.activeChatId.set(chat.id);
          this.session.send(chat.id, content, watch);
          this.scrollToBottom();
        },
        error: () => this.toast.error('Failed to start a new chat')
      });
    } else {
      this.session.send(this.activeChatId()!, content, watch);
      this.scrollToBottom();
    }
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

  /**
   * A chip should read like "searched leads — Tampa", never a wall of JSON.
   * Tool results arrive as a JSON blob, so summarize rather than print it: name
   * the action, and add the most useful detail from the arguments.
   */
  toolLabel(event: EngineToolEvent): string {
    const action = event.toolName.replace(/_/g, ' ');
    const input = event.input as Record<string, unknown> | undefined;
    for (const key of ['companyName', 'groupName', 'name', 'query', 'search', 'email', 'objective']) {
      const value = input?.[key];
      if (typeof value === 'string' && value.trim()) {
        const detail = value.trim();
        return `${action} — ${detail.length > 48 ? `${detail.slice(0, 48)}…` : detail}`;
      }
    }
    return action;
  }

  trackByMessageId(index: number, message: EngineMessage): string {
    return message.id;
  }

  trackByChatId(index: number, chat: EngineChatSummary): string {
    return chat.id;
  }
}
