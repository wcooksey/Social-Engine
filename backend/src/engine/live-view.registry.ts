/**
 * Live view of running agents ("mission control"). Browser sub-agents push
 * their latest screenshot + recent actions here so the UI can show what each
 * agent is literally looking at. In-memory by design: the API and the engine
 * worker share one process (single-service deploy), frames are ephemeral, and
 * keeping ~200KB JPEG frames out of Postgres avoids unbounded bloat.
 */

export interface LiveBrowserFrame {
  /** JPEG as base64 (no data: prefix). */
  imageBase64: string;
  url: string;
  action: string;
  at: number;
}

interface LiveEntry {
  organizationId: string;
  frame?: LiveBrowserFrame;
  /** Rolling window of recent browser actions, newest last. */
  actions: { at: number; note: string }[];
  updatedAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_ACTIONS = 20;

const entries = new Map<string, LiveEntry>();

function prune(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [runId, entry] of entries) {
    if (entry.updatedAt < cutoff) entries.delete(runId);
  }
}

export function recordBrowserAction(runId: string, organizationId: string, note: string): void {
  prune();
  const entry = entries.get(runId) ?? { organizationId, actions: [], updatedAt: 0 };
  entry.actions.push({ at: Date.now(), note });
  if (entry.actions.length > MAX_ACTIONS) entry.actions.splice(0, entry.actions.length - MAX_ACTIONS);
  entry.updatedAt = Date.now();
  entries.set(runId, entry);
}

export function recordBrowserFrame(
  runId: string,
  organizationId: string,
  frame: { imageBase64: string; url: string; action: string }
): void {
  prune();
  const entry = entries.get(runId) ?? { organizationId, actions: [], updatedAt: 0 };
  entry.frame = { ...frame, at: Date.now() };
  entry.updatedAt = Date.now();
  entries.set(runId, entry);
}

/** Frame + actions for one run (org-scoped). */
export function getLiveEntry(runId: string, organizationId: string) {
  const entry = entries.get(runId);
  if (!entry || entry.organizationId !== organizationId) return null;
  return {
    hasFrame: !!entry.frame,
    frameAt: entry.frame?.at ?? null,
    frameUrl: entry.frame?.url ?? null,
    frameAction: entry.frame?.action ?? null,
    actions: entry.actions,
  };
}

export function getFrameImage(runId: string, organizationId: string): LiveBrowserFrame | null {
  const entry = entries.get(runId);
  if (!entry || entry.organizationId !== organizationId) return null;
  return entry.frame ?? null;
}

/** Which of the given runs currently have browser activity. */
export function browserActiveRunIds(runIds: string[], organizationId: string): string[] {
  prune();
  return runIds.filter((id) => {
    const e = entries.get(id);
    return !!e && e.organizationId === organizationId;
  });
}
