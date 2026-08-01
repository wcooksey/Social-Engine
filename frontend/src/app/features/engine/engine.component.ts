import { Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { EngineService } from '../../core/services/engine.service';
import { EngineSessionService } from '../../core/services/engine-session.service';
import { EngineChatSummary, EngineMessage, EngineToolEvent } from '../../core/models/engine.model';
import { PlaybooksService } from '../../core/services/playbooks.service';
import { Playbook } from '../../core/models/playbook.model';
import { ToastService } from '../../core/services/toast.service';
import { VoiceService } from '../../core/services/voice.service';
import { VoiceAgentEvent, VoiceAgentService } from '../../core/services/voice-agent.service';
import { ModelPickerComponent } from './model-picker/model-picker.component';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe';
import { ChatAmbientComponent } from '../../shared/components/chat-ambient/chat-ambient.component';
import { SwitchComponent } from '../../shared/components/switch/switch.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';

/** Conversations under one playbook — one labelled block in the sidebar. */
interface ChatGroup {
  playbookId: string | null;
  label: string;
  chats: EngineChatSummary[];
}

/** Sidebar filter value: '' = every line of business, 'none' = unfiled. */
const ALL_PLAYBOOKS = '';
const UNFILED = 'none';

@Component({
  selector: 'app-engine',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ModelPickerComponent,
    MarkdownPipe,
    ChatAmbientComponent,
    SwitchComponent,
    SelectComponent
  ],
  templateUrl: './engine.component.html',
  styleUrl: './engine.component.scss'
})
export class EngineComponent implements OnInit, OnDestroy {
  chats = signal<EngineChatSummary[]>([]);
  loadingChats = signal(true);

  /**
   * One account can now run several lines of business at once (freight in
   * Tampa, dealerships in Florida). Conversations are filed under the playbook
   * they belong to so the list stays legible instead of becoming one undated
   * pile — and so a playbook can be opened to see everything done under it.
   */
  playbooks = signal<Playbook[]>([]);
  playbookFilter = signal<string>(ALL_PLAYBOOKS);
  filingChat = signal(false);

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
  deletingChatId = signal<string | null>(null);

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

  activeChatTitle = computed(() => this.activeChat()?.title || (this.activeChatId() ? 'New conversation' : 'Engine'));

  /**
   * The open conversation's row, held separately from the list because the
   * sidebar filter can hide it — the thread stays open in the main pane, and
   * without this its playbook picker would fall back to showing the filter
   * instead of what the conversation is actually filed under.
   */
  private openChatRow = signal<EngineChatSummary | null>(null);

  activeChat = computed(() => {
    const id = this.activeChatId();
    if (!id) return null;
    const fromList = this.chats().find(c => c.id === id);
    if (fromList) return fromList;
    const open = this.openChatRow();
    return open?.id === id ? open : null;
  });

  /**
   * Which playbook the picker shows. A new chat has no row to write to yet, so
   * the choice is held here until the first message actually creates it —
   * otherwise picking a playbook before typing would silently do nothing.
   */
  pendingPlaybookId = signal<string | null>(null);

  activePlaybookId = computed(() => {
    const chat = this.activeChat();
    if (chat) return chat.playbookId ?? '';
    const pending = this.pendingPlaybookId();
    if (pending !== null) return pending;
    const filter = this.playbookFilter();
    return filter === UNFILED ? '' : filter;
  });

  /** Filter options: every line of business, plus the unfiled bucket. */
  filterOptions = computed<SelectOption[]>(() => [
    { label: 'All playbooks', value: ALL_PLAYBOOKS },
    ...this.playbooks().map(p => ({ label: p.name, value: p.id })),
    { label: 'Unfiled', value: UNFILED }
  ]);

  /** Picker options for the open chat. Blank files it nowhere. */
  playbookOptions = computed<SelectOption[]>(() => [
    { label: 'No playbook', value: '' },
    ...this.playbooks().map(p => ({
      label: p.isActive ? p.name : `${p.name} (inactive)`,
      value: p.id
    }))
  ]);

  /**
   * Chats bucketed by playbook, each bucket in the playbooks' own priority
   * order, with unfiled last. Grouping beats a flat list here: the question
   * being asked of this sidebar is "what has the Engine done for freight",
   * not "what did I ask it most recently".
   */
  chatGroups = computed<ChatGroup[]>(() => {
    const groups = new Map<string, ChatGroup>();
    for (const playbook of this.playbooks()) {
      groups.set(playbook.id, { playbookId: playbook.id, label: playbook.name, chats: [] });
    }
    const unfiled: ChatGroup = { playbookId: null, label: 'Unfiled', chats: [] };

    for (const chat of this.chats()) {
      const id = chat.playbookId;
      if (!id) {
        unfiled.chats.push(chat);
        continue;
      }
      // A chat whose playbook was deleted or isn't loaded still needs a home,
      // otherwise it would silently vanish from the list.
      let group = groups.get(id);
      if (!group) {
        group = { playbookId: id, label: chat.playbook?.name || 'Unknown playbook', chats: [] };
        groups.set(id, group);
      }
      group.chats.push(chat);
    }

    const filled = [...groups.values()].filter(g => g.chats.length > 0);
    if (unfiled.chats.length) filled.push(unfiled);
    return filled;
  });

  /**
   * Headers only earn their space on the unfiltered list, and only once
   * something is actually filed — before any playbook is used the sidebar
   * should look exactly as it always did.
   */
  showGroupHeaders = computed(
    () => this.playbookFilter() === ALL_PLAYBOOKS && this.chatGroups().some((g) => g.playbookId)
  );

  /** id of the in-progress assistant bubble built from live voice events. */
  private pendingVoiceMessageId: string | null = null;
  private voiceEventsSub?: Subscription;

  constructor(
    protected session: EngineSessionService,
    private engineService: EngineService,
    private playbooksService: PlaybooksService,
    private route: ActivatedRoute,
    private toast: ToastService,
    protected voiceService: VoiceService,
    protected voiceAgent: VoiceAgentService
  ) {
    this.micSupported = this.voiceService.isSupported();
    this.ttsSupported = this.voiceService.isSpeechSynthesisSupported();
  }

  ngOnInit(): void {
    // ?playbook=<id> is how a playbook card opens its own conversations.
    const requested = this.route.snapshot.queryParamMap.get('playbook');
    if (requested) this.playbookFilter.set(requested);

    // Drives the live panel's elapsed timer. One interval for the page, and
    // only while the component is on screen.
    this.clockHandle = setInterval(() => this.clock.set(Date.now()), 1000);

    this.loadPlaybooks();
    this.loadChats();
    this.voiceAgent.checkAvailability();
    this.voiceEventsSub = this.voiceAgent.events$.subscribe((event) => this.onVoiceAgentEvent(event));
    // Coming back to the page: the session service still holds the thread and
    // its stream, so there is nothing to restore — just scroll to where we were.
    if (this.messages().length) this.scrollToBottom();
  }

  ngOnDestroy(): void {
    if (this.clockHandle !== null) {
      clearInterval(this.clockHandle);
      this.clockHandle = null;
    }
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

  loadPlaybooks(): void {
    this.playbooksService.list().subscribe({
      // Playbooks only label and group the sidebar — failing to load them must
      // not stop the conversations themselves from rendering.
      next: (playbooks) => this.playbooks.set(playbooks),
      error: () => this.playbooks.set([])
    });
  }

  loadChats(): void {
    this.loadingChats.set(true);
    this.engineService.listChats(this.playbookFilter() || undefined).subscribe({
      next: (chats) => {
        this.chats.set(chats);
        this.loadingChats.set(false);
      },
      error: () => this.loadingChats.set(false)
    });
  }

  /** Switch which line of business the sidebar is showing. */
  onFilterChange(value: string): void {
    this.playbookFilter.set(value ?? ALL_PLAYBOOKS);
    this.loadChats();
  }

  /**
   * File the open conversation under a playbook. Takes effect on the NEXT run —
   * the prompt is built when a run starts, so re-filing mid-thread won't rewrite
   * what has already happened.
   */
  setActivePlaybook(playbookId: string): void {
    const chatId = this.activeChatId();
    if (!chatId) {
      // Nothing to persist yet — remember it for the chat the first message makes.
      this.pendingPlaybookId.set(playbookId || '');
      return;
    }
    const next = playbookId || null;
    if ((this.activeChat()?.playbookId ?? null) === next) return;

    this.filingChat.set(true);
    this.engineService.setChatPlaybook(chatId, next).subscribe({
      next: (updated) => {
        this.filingChat.set(false);
        this.openChatRow.set(updated);
        // Drop it from view if it no longer matches the active filter, rather
        // than leaving a row that contradicts the filter above it.
        const filter = this.playbookFilter();
        const stillMatches =
          filter === ALL_PLAYBOOKS ||
          (filter === UNFILED ? !updated.playbookId : updated.playbookId === filter);
        this.chats.update((list) =>
          stillMatches
            ? list.map((c) => (c.id === updated.id ? { ...c, ...updated } : c))
            : list.filter((c) => c.id !== updated.id)
        );
        this.toast.success(
          updated.playbook ? `Filed under ${updated.playbook.name}` : 'Removed from its playbook'
        );
      },
      error: () => {
        this.filingChat.set(false);
        this.toast.error('Could not change this conversation\'s playbook');
      }
    });
  }

  selectChat(chat: EngineChatSummary): void {
    if (this.sending()) return;
    this.openChatRow.set(chat);
    // Scroll only once the messages are actually in the DOM — opening a
    // conversation should land you at the latest message, not the first.
    this.session.openChat(chat.id, true, () => this.scrollToBottom());
  }

  /** Remove a conversation. Confirmed, since the thread isn't recoverable. */
  deleteChat(chat: EngineChatSummary, event: Event): void {
    event.stopPropagation();
    if (this.deletingChatId()) return;
    if (this.sending() && this.activeChatId() === chat.id) {
      this.toast.warning('This conversation has a run in progress — stop it first');
      return;
    }
    if (!confirm(`Delete "${chat.title || 'New conversation'}"? This can't be undone.`)) return;

    this.deletingChatId.set(chat.id);
    this.engineService.deleteChat(chat.id).subscribe({
      next: () => {
        this.deletingChatId.set(null);
        this.chats.update((list) => list.filter((c) => c.id !== chat.id));
        if (this.openChatRow()?.id === chat.id) this.openChatRow.set(null);
        // Clear the thread if the open conversation is the one that just went.
        if (this.activeChatId() === chat.id) this.session.startNewChat();
        this.toast.success('Conversation deleted');
      },
      error: () => {
        this.deletingChatId.set(null);
        this.toast.error('Could not delete that conversation');
      }
    });
  }

  startNewChat(): void {
    if (this.sending()) return;
    this.session.startNewChat();
    this.openChatRow.set(null);
    this.pendingPlaybookId.set(null);
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

  // --- Live activity panel -------------------------------------------------

  /** Tool activity for the run in flight, newest last. */
  liveSteps = this.session.activeToolEvents;

  /** Ticks once a second purely so the elapsed time re-renders. */
  private clock = signal(Date.now());
  private clockHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * How long the current run has been going, as "12s" / "1m 04s". Reads from a
   * signal that ticks rather than from Date.now() directly, because a template
   * calling Date.now() would never update on its own.
   */
  liveElapsed = computed(() => {
    const started = this.session.runStartedAt();
    if (!started) return '';
    const seconds = Math.max(0, Math.floor((this.clock() - started) / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  });

  /** A tool's result trimmed to something that fits one line. */
  shortResult(event: EngineToolEvent): string {
    const summary = (event.summary || '').replace(/\s+/g, ' ').trim();
    if (!summary) return '';
    return summary.length > 60 ? `${summary.slice(0, 60)}…` : summary;
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
      // The new conversation is born into whichever line of business the
      // sidebar is showing (or the one picked above), so it never lands unfiled
      // while you are working a single segment.
      this.engineService.createChat(this.activePlaybookId() || null).subscribe({
        next: (chat) => {
          this.chats.update(list => [chat, ...list]);
          this.openChatRow.set(chat);
          this.pendingPlaybookId.set(null);
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
