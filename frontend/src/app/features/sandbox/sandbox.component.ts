import { CampaignPreviewComponent } from '../group-workspace/campaign-preview.component';
import { RouterModule } from '@angular/router';
import { inject } from '@angular/core';
import { GroupContextService } from '../../core/services/group-context.service';
import { Component, ElementRef, OnInit, ViewChild, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  CoachContext,
  CoachProposal,
  SandboxAction,
  SandboxChannel,
  SandboxService
} from '../../core/services/sandbox.service';
import { LeadsService } from '../../core/services/leads.service';
import { ModelsService } from '../../core/services/models.service';
import { ToastService } from '../../core/services/toast.service';
import { apiErrorMessage } from '../../core/utils/api-error';
import { Lead } from '../../core/models/lead.model';
import { CardComponent } from '../../shared/components/card/card.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { SelectComponent, SelectOption } from '../../shared/components/select/select.component';
import { BadgeComponent } from '../../shared/components/badge/badge.component';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe';

interface SandboxTurn {
  role: 'user' | 'assistant';
  content: string;
  actions?: SandboxAction[];
  composed?: { subject?: string; body?: string; message?: string }[];
}

interface CoachTurnView {
  role: 'user' | 'assistant';
  content: string;
  proposals?: (CoachProposal & { applied?: boolean; applying?: boolean })[];
}

/**
 * Sandbox — rehearse what the AI SAYS before a real prospect hears it.
 *
 * Deliberately separate from Settings → test bench, which sends real messages
 * to prove the plumbing works. Here you play the prospect and the same SDR
 * role, playbooks and prompt that handle live replies answer you, with every
 * sending/writing tool intercepted server-side. The voice panel is the one
 * place a real thing happens: it calls YOU, with the real call persona, so you
 * can hear what a lead hears and tune it.
 */
@Component({
  selector: 'app-sandbox',
  standalone: true,
  imports: [
    CampaignPreviewComponent,
    RouterModule,
    CommonModule,
    FormsModule,
    CardComponent,
    ButtonComponent,
    InputComponent,
    SelectComponent,
    BadgeComponent,
    MarkdownPipe
  ],
  templateUrl: './sandbox.component.html',
  styleUrl: './sandbox.component.scss'
})
export class SandboxComponent implements OnInit {
  context = inject(GroupContextService);
  readonly workspaceGroupId = this.context.currentId();

  tab = signal<'chat' | 'voice' | 'coach'>('chat');

  // --- Conversation rehearsal ---
  channel: SandboxChannel = 'EMAIL';
  leadId = '';
  draft = '';
  turns = signal<SandboxTurn[]>([]);
  thinking = signal(false);

  // --- Voice rehearsal ---
  phone = '';
  callObjective = '';
  firstMessage = '';
  voiceLeadId = '';
  calling = signal(false);
  callPrompt = signal<string | null>(null);
  hasVoicePlaybooks = signal(true);
  showPrompt = signal(false);

  // --- Call coach ---
  coachTurns = signal<CoachTurnView[]>([]);
  coachDraft = '';
  coachThinking = signal(false);
  coachContext = signal<CoachContext | null>(null);
  coachModel = '';
  showCallPrompt = signal(false);

  leads = signal<Lead[]>([]);

  @ViewChild('threadEnd') threadEnd?: ElementRef<HTMLDivElement>;
  @ViewChild('coachEnd') coachEnd?: ElementRef<HTMLDivElement>;

  channelOptions: SelectOption[] = [
    { label: 'Email', value: 'EMAIL' },
    { label: 'SMS', value: 'SMS' },
    { label: 'Facebook DM', value: 'FACEBOOK' },
    { label: 'Instagram DM', value: 'INSTAGRAM' },
    { label: 'LinkedIn DM', value: 'LINKEDIN' }
  ];

  /** Openers worth testing — the replies that actually decide a deal. */
  examples = [
    "Who is this? I didn't sign up for anything.",
    "Not interested, take me off your list.",
    "How much does it cost?",
    "We already work with someone for this.",
    "Sounds interesting — can you send more info?",
    "Sure, what times are you free this week?"
  ];

  /** Openers for the coach — the questions worth its first answer. */
  coachExamples = [
    'Our biggest problem is getting past the receptionist. What should the bot say?',
    'Write me an opening line for calling used car dealerships cold.',
    'Look at the outcomes below — what is the single biggest thing to fix?',
    'A GM says "just email me something". What should the bot do?',
    'How should the bot handle "we already have a vendor for that"?'
  ];

  constructor(
    private sandbox: SandboxService,
    private leadsService: LeadsService,
    private modelsService: ModelsService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    // A short list is enough — this is for grounding a rehearsal, not browsing.
    this.leadsService.list({ groupId: this.workspaceGroupId || undefined, pageSize: 50, sort: 'score', sortDir: 'desc' }).subscribe({
      next: (res) => this.leads.set(res.leads),
      error: () => this.leads.set([])
    });
    if (!this.workspaceGroupId) this.refreshCallPrompt();
    this.modelsService.getModels().subscribe({
      next: (res) => (this.coachModel = res.coachCurrent || res.current),
      error: () => undefined
    });
    if (!this.workspaceGroupId) this.loadCoachContext();
  }

  get modelOptions(): SelectOption[] {
    return this.modelsService.modelOptionsWithCurrent().map((m) => ({
      label: `${m.label}${m.configured ? '' : ' (no API key)'}`,
      value: m.id
    }));
  }

  get leadOptions(): SelectOption[] {
    return this.leads().map((l) => ({
      label: `${l.companyName}${l.city ? ` — ${l.city}` : ''}`,
      value: l.id
    }));
  }

  channelLabel(channel: SandboxChannel): string {
    return this.channelOptions.find((o) => o.value === channel)?.label ?? channel;
  }

  // --- Conversation ------------------------------------------------------

  useExample(text: string): void {
    this.draft = text;
  }

  resetConversation(): void {
    this.turns.set([]);
    this.draft = '';
  }

  handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendAsProspect();
    }
  }

  sendAsProspect(): void {
    const message = this.draft.trim();
    if (!message || this.thinking()) return;
    this.draft = '';

    const history = this.turns().map((t) => ({ role: t.role, content: t.content }));
    this.turns.update((list) => [...list, { role: 'user', content: message }]);
    this.thinking.set(true);
    this.scrollToBottom();

    this.sandbox
      .reply({ groupId: this.workspaceGroupId || undefined, channel: this.channel, message, leadId: this.leadId || undefined, history })
      .subscribe({
        next: (res) => {
          this.thinking.set(false);
          this.turns.update((list) => [
            ...list,
            {
              role: 'assistant',
              content: res.reply || res.error || '(the Engine produced no reply)',
              actions: res.actions,
              composed: res.composed
            }
          ]);
          this.scrollToBottom();
        },
        error: (err) => {
          this.thinking.set(false);
          this.toast.error(apiErrorMessage(err, 'Rehearsal failed'));
        }
      });
  }

  /** Readable one-liner for an action the AI would have taken. */
  describeAction(action: SandboxAction): string {
    const args = (action.input ?? {}) as Record<string, unknown>;
    const readable = action.toolName.replace(/_/g, ' ');
    for (const key of ['subject', 'body', 'message', 'status', 'title', 'note']) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) {
        return `${readable}: ${value.trim().slice(0, 90)}${value.length > 90 ? '…' : ''}`;
      }
    }
    return readable;
  }

  private scrollToBottom(): void {
    setTimeout(() => this.threadEnd?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'end' }), 0);
  }

  // --- Voice -------------------------------------------------------------

  refreshCallPrompt(): void {
    this.sandbox.callPrompt(this.voiceLeadId || undefined, this.callObjective || undefined).subscribe({
      next: (res) => {
        this.callPrompt.set(res.systemPrompt);
        this.hasVoicePlaybooks.set(res.hasVoicePlaybooks);
      },
      error: () => this.callPrompt.set(null)
    });
  }

  callMe(): void {
    const to = this.phone.trim();
    if (!to) {
      this.toast.warning('Enter the number to call');
      return;
    }
    this.calling.set(true);
    this.sandbox
      .callMe({
        to,
        leadId: this.voiceLeadId || undefined,
        objective: this.callObjective.trim() || undefined,
        firstMessage: this.firstMessage.trim() || undefined
      })
      .subscribe({
        next: (res) => {
          this.calling.set(false);
          this.callPrompt.set(res.systemPrompt);
          this.hasVoicePlaybooks.set(res.usedVoicePlaybooks);
          this.toast.success(res.note);
        },
        error: (err) => {
          this.calling.set(false);
          this.toast.error(apiErrorMessage(err, 'Could not place the call'));
        }
      });
  }

  // --- Call coach --------------------------------------------------------

  loadCoachContext(): void {
    this.sandbox.coachContext().subscribe({
      next: (ctx) => this.coachContext.set(ctx),
      error: () => this.coachContext.set(null)
    });
  }

  /** The coach's model is its own; changing it here doesn't touch the Engine. */
  onCoachModelChange(id: string): void {
    if (!id) return;
    this.modelsService.setCoachModel(id).subscribe({
      next: () => this.toast.success('Coach model updated'),
      error: (err) => this.toast.error(apiErrorMessage(err, 'Could not change the model'))
    });
  }

  useCoachExample(text: string): void {
    this.coachDraft = text;
  }

  resetCoach(): void {
    this.coachTurns.set([]);
    this.coachDraft = '';
  }

  handleCoachKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.askCoach();
    }
  }

  askCoach(): void {
    const message = this.coachDraft.trim();
    if (!message || this.coachThinking()) return;
    this.coachDraft = '';

    this.coachTurns.update((list) => [...list, { role: 'user', content: message }]);
    this.coachThinking.set(true);
    this.scrollCoachToBottom();

    const messages = this.coachTurns().map((t) => ({ role: t.role, content: t.content }));
    this.sandbox.coach({ messages, model: this.coachModel || undefined }).subscribe({
      next: (res) => {
        this.coachThinking.set(false);
        this.coachTurns.update((list) => [
          ...list,
          {
            role: 'assistant',
            content: res.reply || '(no reply)',
            proposals: res.proposals?.map((p) => ({ ...p }))
          }
        ]);
        this.scrollCoachToBottom();
      },
      error: (err) => {
        this.coachThinking.set(false);
        this.toast.error(apiErrorMessage(err, 'The coach could not answer'));
      }
    });
  }

  /** Applying is deliberately a separate click — this changes every future call. */
  applyProposal(turnIndex: number, proposalIndex: number): void {
    const turn = this.coachTurns()[turnIndex];
    const proposal = turn?.proposals?.[proposalIndex];
    if (!proposal || proposal.applied || proposal.applying) return;

    this.updateProposal(turnIndex, proposalIndex, { applying: true });
    this.sandbox
      .applyProposal({
        playbookId: proposal.playbookId,
        name: proposal.name,
        instructions: proposal.instructions
      })
      .subscribe({
        next: (res) => {
          this.updateProposal(turnIndex, proposalIndex, { applying: false, applied: true });
          this.toast.success(res.note);
          // The prompt and playbook list the coach reasons from just changed.
          if (!this.workspaceGroupId) this.loadCoachContext();
          this.refreshCallPrompt();
        },
        error: (err) => {
          this.updateProposal(turnIndex, proposalIndex, { applying: false });
          this.toast.error(apiErrorMessage(err, 'Could not apply the playbook'));
        }
      });
  }

  private updateProposal(
    turnIndex: number,
    proposalIndex: number,
    patch: { applied?: boolean; applying?: boolean }
  ): void {
    this.coachTurns.update((list) =>
      list.map((turn, i) =>
        i !== turnIndex
          ? turn
          : {
              ...turn,
              proposals: turn.proposals?.map((p, j) => (j === proposalIndex ? { ...p, ...patch } : p))
            }
      )
    );
  }

  private scrollCoachToBottom(): void {
    setTimeout(() => this.coachEnd?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'end' }), 0);
  }
}
