import { config } from '../../config/environment';
import { estimateCostUsd, ProviderKeys } from '../llm/catalog';
import { llmService, LlmMessage, LlmToolDefinition } from '../llm/llm.service';
import { BrowserSession, PageObservation } from './browser.service';

export interface BrowserAgentResult {
  status: 'completed' | 'max_steps' | 'failed';
  summary: string;
  finalUrl?: string;
  /** Structured data the agent chose to return (profiles, contacts, etc.). */
  data?: unknown;
  steps: number;
  error?: string;
  /** LLM usage across all browser steps (for cost attribution to the run). */
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

export interface BrowserAgentOptions {
  objective: string;
  startUrl?: string;
  model: string;
  /** Org-resolved provider API keys (settings → env fallback). Without these
   *  the LLM layer only sees env vars and org-configured keys never apply. */
  providerKeys?: ProviderKeys;
  /** If false, the agent may research/read but must NOT send messages/DMs. */
  allowSend: boolean;
  /** Pre-authenticated session (cookies + localStorage) to start logged in. */
  storageState?: Record<string, unknown>;
  /** Called with the refreshed session after the run, to keep the login alive. */
  persistState?: (state: Record<string, unknown>) => Promise<void>;
  onStep?: (note: string) => void;
}

const BROWSER_TOOLS: LlmToolDefinition[] = [
  {
    name: 'goto',
    description: 'Navigate to a URL and observe the resulting page.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'click',
    description: 'Click the interactive element with the given index from the current observation.',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number' } },
      required: ['index'],
    },
  },
  {
    name: 'type',
    description:
      'Type text into the input/textarea with the given index. Set submit=true to press Enter after (e.g. to run a search or send a message).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number' },
        text: { type: 'string' },
        submit: { type: 'boolean' },
      },
      required: ['index', 'text'],
    },
  },
  {
    name: 'finish',
    description:
      'End the task. Provide a concise summary of what you accomplished and any data you gathered (e.g. profile URLs, names, whether a message was sent or drafted).',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        data: { type: 'object', description: 'Optional structured findings' },
      },
      required: ['summary'],
    },
  },
];

function renderObservation(obs: PageObservation): string {
  const els = obs.elements
    .map((e) => {
      const label =
        e.text || e.attributes.ariaLabel || e.attributes.placeholder || e.attributes.name || '';
      const href = e.attributes.href ? ` href=${e.attributes.href.slice(0, 80)}` : '';
      return `[${e.index}] <${e.tag}> ${label}${href}`.trim();
    })
    .join('\n');
  return `URL: ${obs.url}\nTITLE: ${obs.title}\n\nINTERACTIVE ELEMENTS:\n${els}\n\nPAGE TEXT:\n${obs.text}`;
}

/**
 * A browser-use agent: an LLM loop that observes a web page and issues browser
 * actions to accomplish an objective (research a lead on social, find a
 * decision maker, open and send a DM). Runs the pre-installed Chromium via
 * Playwright. Sending is gated by allowSend.
 */
export async function runBrowserAgent(opts: BrowserAgentOptions): Promise<BrowserAgentResult> {
  const session = new BrowserSession();
  const maxSteps = config.browser.maxSteps;
  const note = opts.onStep ?? (() => undefined);
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  const system = `You are a browser automation agent operating a real Chromium browser to accomplish a web task for a sales team.

Objective: ${opts.objective}

## How you work
- You see each page as its URL, title, a numbered list of interactive elements, and the page's readable text.
- Act by calling goto / click / type. Reference elements by their index from the LATEST observation only (indices change every step).
- To search or send a message, type into the field then set submit=true to press Enter, OR click the dedicated button.
- Work efficiently: you have at most ${maxSteps} steps. Don't re-read pages you've seen.
- When done (or blocked), call finish with a clear summary and any data you found (profile URLs, names, titles, whether a message was sent).

## Rules
- ${opts.allowSend ? 'You MAY send a direct message / connection request when the objective calls for it. Keep it short, professional, and personalized. Confirm the message actually sent before calling finish.' : 'You MUST NOT send any message, DM, connection request, or form submission. Research and gather information only. If the objective asks to message someone, instead locate the right profile/contact and finish with what you found so a human can review.'}
- Never enter passwords or complete logins. If a page requires login, finish and report that authentication is needed.
- Never invent information — only report what you actually observed on the pages.`;

  const messages: LlmMessage[] = [
    {
      role: 'user',
      content: opts.startUrl
        ? `Start at ${opts.startUrl}. Begin.`
        : 'Begin. Navigate to an appropriate starting page (e.g. a search engine or the relevant social platform).',
    },
  ];

  const persist = async () => {
    if (!opts.persistState) return;
    try {
      const state = await session.exportState();
      await opts.persistState(state);
    } catch {
      /* best-effort session refresh */
    }
  };

  try {
    await session.open({ storageState: opts.storageState });

    for (let step = 0; step < maxSteps; step++) {
      const response = await llmService.chatWithFailover(
        {
          model: opts.model,
          system,
          messages,
          tools: BROWSER_TOOLS,
          maxTokens: 1500,
        },
        opts.providerKeys
      );
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.costUsd += estimateCostUsd(
        response.model,
        response.usage.inputTokens,
        response.usage.outputTokens
      );

      if (response.toolCalls.length === 0) {
        // Model answered without acting — treat its text as the summary.
        await persist();
        await session.close();
        return {
          status: 'completed',
          summary: response.text || 'No action taken.',
          steps: step,
          usage,
        };
      }

      messages.push({
        role: 'assistant',
        content: response.text,
        toolCalls: response.toolCalls,
      });

      const results: { toolCallId: string; name: string; content: string; isError?: boolean }[] =
        [];

      for (const call of response.toolCalls) {
        if (call.name === 'finish') {
          const input = call.input as { summary?: string; data?: unknown };
          await persist();
          await session.close();
          return {
            status: 'completed',
            summary: input.summary || 'Task finished.',
            data: input.data,
            steps: step + 1,
            usage,
          };
        }

        note(`${call.name}(${JSON.stringify(call.input).slice(0, 80)})`);
        let obs: PageObservation | null = null;
        let error: string | undefined;
        try {
          if (call.name === 'goto') {
            obs = await session.goto((call.input as { url: string }).url);
          } else if (call.name === 'click') {
            obs = await session.click((call.input as { index: number }).index);
          } else if (call.name === 'type') {
            const i = call.input as { index: number; text: string; submit?: boolean };
            if (!opts.allowSend && i.submit) {
              // Guard: don't let a submit slip through in research-only mode.
              error =
                'Submitting is disabled in research-only mode. Gather info and finish instead.';
            } else {
              obs = await session.type(i.index, i.text, !!i.submit);
            }
          } else {
            error = `Unknown action ${call.name}`;
          }
        } catch (err) {
          error = err instanceof Error ? err.message : 'Action failed';
        }

        results.push({
          toolCallId: call.id,
          name: call.name,
          content: error ? `ERROR: ${error}` : renderObservation(obs!),
          isError: !!error,
        });
      }
      messages.push({ role: 'tool', results });
    }

    await persist();
    await session.close();
    return {
      status: 'max_steps',
      summary: `Reached the ${maxSteps}-step limit without finishing. Consider a narrower objective.`,
      steps: maxSteps,
      usage,
    };
  } catch (err) {
    await session.close();
    return {
      status: 'failed',
      summary: 'Browser agent failed.',
      error: err instanceof Error ? err.message : 'Unknown error',
      steps: 0,
      usage,
    };
  }
}
