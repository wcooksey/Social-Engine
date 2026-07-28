import { Component, ElementRef, OnInit, ViewChild, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SandboxAction, SandboxChannel, SandboxService } from '../../core/services/sandbox.service';
import { LeadsService } from '../../core/services/leads.service';
import { ToastService } from '../../core/services/toast.service';
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
  tab = signal<'chat' | 'voice'>('chat');

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

  leads = signal<Lead[]>([]);

  @ViewChild('threadEnd') threadEnd?: ElementRef<HTMLDivElement>;

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

  constructor(
    private sandbox: SandboxService,
    private leadsService: LeadsService,
    private toast: ToastService
  ) {}

  ngOnInit(): void {
    // A short list is enough — this is for grounding a rehearsal, not browsing.
    this.leadsService.list({ pageSize: 50, sort: 'score', sortDir: 'desc' }).subscribe({
      next: (res) => this.leads.set(res.leads),
      error: () => this.leads.set([])
    });
    this.refreshCallPrompt();
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
      .reply({ channel: this.channel, message, leadId: this.leadId || undefined, history })
      .subscribe({
        next: (res) => {
          this.thinking.set(false);
          this.turns.update((list) => [
            ...list,
            {
              role: 'assistant',
              content: res.reply || res.error || '(the Engine produced no reply)',
              actions: res.actions
            }
          ]);
          this.scrollToBottom();
        },
        error: (err) => {
          this.thinking.set(false);
          this.toast.error(err?.error?.error?.message || 'Rehearsal failed');
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
          this.toast.error(err?.error?.error?.message || 'Could not place the call');
        }
      });
  }
}
