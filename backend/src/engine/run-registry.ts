import type { EngineEvent } from './engine.service';

/**
 * Live registry of in-flight Engine runs — the piece that lets a run outlive
 * the HTTP request that started it.
 *
 * Before this, a chat run WAS its request: events streamed straight into one
 * response, so navigating away killed the stream with no way back, and nothing
 * held a handle on the run to pause or stop it. Here each run gets:
 *
 *  - an indexed event buffer, so any client can attach at any time and replay
 *    from wherever it left off (reattach after navigation, or watch from a
 *    second tab/device);
 *  - a fan-out set of subscribers for live tailing;
 *  - control state (pause / resume / cancel / step) that the run loop consults
 *    at checkpoints between tool calls.
 *
 * In-memory by design, matching live-view.registry: the API and the engine
 * worker share one process, and the durable record already exists as
 * AgentRun + AgentStep rows for anything older than the buffer.
 */

export type RunPhase =
  | 'running'
  | 'paused'
  | 'awaiting_step' // watch mode: parked until the operator advances it
  | 'cancelling'
  | 'finished';

export type RunControlAction = 'pause' | 'resume' | 'cancel' | 'step' | 'watch_on' | 'watch_off';

/** An event plus its position, so clients can resume from an offset. */
export interface IndexedEvent {
  index: number;
  event: StreamEvent;
  /**
   * A state snapshot sent on attach rather than a real buffered event. It has
   * no position of its own, so clients must NOT advance their resume cursor
   * past it — doing so swallows the next real event.
   */
  snapshot?: boolean;
}

/** Pushed to subscribers whenever a run's control state changes. */
export interface RunStatusEvent {
  type: 'run_status';
  runId: string;
  phase: RunPhase;
  watch: boolean;
  /** What the run is about to do (or is doing) — drives the "current step" line. */
  currentStep?: string;
}

export type StreamEvent = EngineEvent | RunStatusEvent;

type Subscriber = (item: IndexedEvent) => void;

interface ActiveRun {
  runId: string;
  organizationId: string;
  userId?: string;
  chatId?: string;
  objective: string;
  trigger: string;
  role: string;
  startedAt: number;
  finishedAt?: number;
  status?: 'COMPLETED' | 'FAILED' | 'CANCELLED';

  events: IndexedEvent[];
  nextIndex: number;
  subscribers: Set<Subscriber>;

  phase: RunPhase;
  watch: boolean;
  cancelRequested: boolean;
  pauseRequested: boolean;
  /** Watch mode: how many more checkpoints may pass without operator input. */
  stepCredits: number;
  /** Wakes the gate when a control action arrives. */
  wake?: () => void;
  currentStep?: string;
}

/** Keep finished runs briefly so a late reattach still sees the tail. */
const FINISHED_TTL_MS = 5 * 60 * 1000;
/** Hard cap per run; older events fall back to AgentStep rows for replay. */
const MAX_BUFFERED_EVENTS = 1000;

const runs = new Map<string, ActiveRun>();

/** Thrown by the gate when an operator cancels — caught by the run loop. */
export class RunCancelledError extends Error {
  constructor() {
    super('Run cancelled by operator');
    this.name = 'RunCancelledError';
  }
}

function prune(): void {
  const cutoff = Date.now() - FINISHED_TTL_MS;
  for (const [runId, run] of runs) {
    if (run.finishedAt && run.finishedAt < cutoff && run.subscribers.size === 0) {
      runs.delete(runId);
    }
  }
}

export function registerRun(input: {
  runId: string;
  organizationId: string;
  userId?: string;
  chatId?: string;
  objective: string;
  trigger: string;
  role: string;
  /** Start parked in watch mode (operator advances each step). */
  watch?: boolean;
}): void {
  prune();
  runs.set(input.runId, {
    ...input,
    startedAt: Date.now(),
    events: [],
    nextIndex: 0,
    subscribers: new Set(),
    phase: 'running',
    watch: !!input.watch,
    cancelRequested: false,
    pauseRequested: false,
    // In watch mode the first checkpoint parks immediately; otherwise the run
    // is never gated on credits.
    stepCredits: 0,
  });
}

/** Buffer an event and fan it out to everyone currently attached. */
export function publish(runId: string, event: StreamEvent): void {
  const run = runs.get(runId);
  if (!run) return;
  const item = { index: run.nextIndex++, event };
  run.events.push(item);
  if (run.events.length > MAX_BUFFERED_EVENTS) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS);
  }
  for (const subscriber of run.subscribers) {
    try {
      subscriber(item);
    } catch {
      /* a broken subscriber must never break the run */
    }
  }
}

function publishStatus(run: ActiveRun): void {
  publish(run.runId, {
    type: 'run_status',
    runId: run.runId,
    phase: run.phase,
    watch: run.watch,
    currentStep: run.currentStep,
  });
}

/**
 * Attach to a run, replaying anything buffered from `fromIndex` before live
 * tailing. Returns an unsubscribe function, or null if the run is unknown.
 */
export function subscribe(
  runId: string,
  organizationId: string,
  fromIndex: number,
  subscriber: Subscriber
): (() => void) | null {
  const run = runs.get(runId);
  if (!run || run.organizationId !== organizationId) return null;

  for (const item of run.events) {
    if (item.index >= fromIndex) subscriber(item);
  }
  // Tell the newcomer where things stand (paused? parked? already finished?).
  // Flagged as a snapshot and given the LAST consumed index, not nextIndex:
  // nextIndex belongs to the event that hasn't happened yet, and a client that
  // recorded it as seen would discard that event when it arrives.
  subscriber({
    index: run.nextIndex - 1,
    snapshot: true,
    event: {
      type: 'run_status',
      runId: run.runId,
      phase: run.phase,
      watch: run.watch,
      currentStep: run.currentStep,
    },
  });

  run.subscribers.add(subscriber);
  return () => {
    run.subscribers.delete(subscriber);
    prune();
  };
}

/**
 * The checkpoint. The run loop awaits this before each tool call and each
 * iteration: it throws if cancelled, and parks while paused or waiting for the
 * operator to advance a watched run.
 *
 * Cancellation is only observed here, so a request to stop always lands between
 * whole steps — never mid-tool-call, which would leave partial work behind.
 */
export async function checkpoint(runId: string, label?: string): Promise<void> {
  const run = runs.get(runId);
  if (!run) return; // not tracked (e.g. a worker run started before registration)

  run.currentStep = label;

  for (;;) {
    if (run.cancelRequested) {
      run.phase = 'cancelling';
      publishStatus(run);
      throw new RunCancelledError();
    }

    const parkedForStep = run.watch && run.stepCredits <= 0;
    if (!run.pauseRequested && !parkedForStep) {
      if (run.watch) run.stepCredits--;
      if (run.phase !== 'running') {
        run.phase = 'running';
      }
      publishStatus(run);
      return;
    }

    run.phase = run.pauseRequested ? 'paused' : 'awaiting_step';
    publishStatus(run);
    await new Promise<void>((resolve) => {
      run.wake = resolve;
    });
    run.wake = undefined;
  }
}

/** Apply an operator control action. Returns the resulting phase. */
export function control(
  runId: string,
  organizationId: string,
  action: RunControlAction
): { phase: RunPhase; watch: boolean } | null {
  const run = runs.get(runId);
  if (!run || run.organizationId !== organizationId) return null;
  // Finished runs linger briefly so a late reattach can replay the tail, but
  // they are not steerable — reporting "pausing…" for a dead run would be a lie.
  if (run.phase === 'finished') return null;

  switch (action) {
    case 'pause':
      run.pauseRequested = true;
      break;
    case 'resume':
      run.pauseRequested = false;
      // Resuming a watched run hands back continuous credit until re-watched.
      if (run.watch) run.stepCredits = Number.MAX_SAFE_INTEGER;
      break;
    case 'cancel':
      run.cancelRequested = true;
      break;
    case 'step':
      // Advance exactly one checkpoint, and un-pause so the gate lets it by.
      run.pauseRequested = false;
      run.watch = true;
      run.stepCredits = 1;
      break;
    case 'watch_on':
      run.watch = true;
      run.stepCredits = 0;
      break;
    case 'watch_off':
      run.watch = false;
      run.stepCredits = 0;
      break;
  }

  // Wake the gate so it re-evaluates against the new state.
  run.wake?.();
  return { phase: run.phase, watch: run.watch };
}

export function finishRun(runId: string, status: 'COMPLETED' | 'FAILED' | 'CANCELLED'): void {
  const run = runs.get(runId);
  if (!run) return;
  run.phase = 'finished';
  run.status = status;
  run.finishedAt = Date.now();
  run.currentStep = undefined;
  publishStatus(run);
  prune();
}

export interface ActiveRunSummary {
  runId: string;
  organizationId: string;
  chatId?: string;
  objective: string;
  trigger: string;
  role: string;
  phase: RunPhase;
  watch: boolean;
  currentStep?: string;
  startedAt: number;
  eventCount: number;
  /** Most recent tool names, newest last — the run's activity at a glance. */
  recentTools: string[];
  watchers: number;
}

/** Everything currently in flight for an org — the fleet view's data source. */
export function listRuns(organizationId: string, includeFinished = false): ActiveRunSummary[] {
  prune();
  const out: ActiveRunSummary[] = [];
  for (const run of runs.values()) {
    if (run.organizationId !== organizationId) continue;
    if (!includeFinished && run.phase === 'finished') continue;
    const recentTools: string[] = [];
    for (let i = run.events.length - 1; i >= 0 && recentTools.length < 5; i--) {
      const event = run.events[i].event;
      if (event.type === 'tool_call') recentTools.unshift(event.toolName);
    }
    out.push({
      runId: run.runId,
      organizationId: run.organizationId,
      chatId: run.chatId,
      objective: run.objective,
      trigger: run.trigger,
      role: run.role,
      phase: run.phase,
      watch: run.watch,
      currentStep: run.currentStep,
      startedAt: run.startedAt,
      eventCount: run.nextIndex,
      recentTools,
      watchers: run.subscribers.size,
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** The live run attached to a chat, if any — used to reattach on page load. */
export function findRunForChat(organizationId: string, chatId: string): ActiveRunSummary | null {
  return (
    listRuns(organizationId, true).find((r) => r.chatId === chatId && r.phase !== 'finished') ?? null
  );
}

export function isTracked(runId: string): boolean {
  return runs.has(runId);
}
