/**
 * Call outcome classification.
 *
 * Vapi hands back an endedReason, a summary and a transcript. On their own those
 * are prose, so every decision after a call — retry, try another channel, stop —
 * depended on an agent reading them and improvising, and nothing could be
 * measured. Classifying into a fixed taxonomy makes the next action mechanical
 * and makes connect/gatekeeper/voicemail rates countable.
 */

export type CallOutcome =
  | 'reached_decision_maker' // spoke to someone who can actually say yes
  | 'reached_someone' // a human answered, but not the target
  | 'gatekeeper' // blocked before reaching the target
  | 'callback_requested' // asked us to try at a specific time
  | 'voicemail' // left (or hit) voicemail
  | 'no_answer' // rang out, busy, or they hung up immediately
  | 'wrong_number' // right business, wrong line — or not this business
  | 'bad_number' // disconnected/invalid — do not dial again
  | 'not_interested' // explicit no
  | 'do_not_call' // explicit "stop calling me"
  | 'failed'; // our side broke (provider error)

export interface ClassifiedCall {
  outcome: CallOutcome;
  /** True when the number itself should never be dialled again. */
  retireNumber: boolean;
  /** True when the lead asked us to stop entirely. */
  optOut: boolean;
  /** What the follow-up job should actually do. */
  nextAction: string;
  /** Short human-readable label for the timeline. */
  label: string;
}

/** Phrases a person uses to end contact for good. Kept tight to avoid false positives. */
const DO_NOT_CALL_RE =
  /\b(stop calling|don'?t call (me|us) again|take (me|us) off your (list|records)|remove (me|us) from your (list|database)|do not call)\b/i;

const NOT_INTERESTED_RE =
  /\b(not interested|no thanks?|we'?re all set|we'?re good|not looking|no need|already have|happy with (our|what))\b/i;

const GATEKEEPER_RE =
  /\b(not available|in a meeting|out of the office|not in (today|right now)|can i take a message|who'?s calling|what'?s this (about|regarding)|leave (a|your) (message|number)|he'?s busy|she'?s busy|transfer you)\b/i;

const WRONG_NUMBER_RE =
  /\b(wrong number|no one here by that name|nobody (here )?by that|you'?ve got the wrong|there'?s no \w+ here)\b/i;

const CALLBACK_RE =
  /\b(call (me|us|him|her) back|try (again|back)|call after|available (after|at)|better time|reach (me|him|her) (at|after)|call (me|us) (tomorrow|monday|tuesday|wednesday|thursday|friday|next week))\b/i;

const DECISION_MAKER_RE =
  /\b(i'?m the (owner|gm|general manager|sales manager|director)|speaking|this is (he|she|him|her)|i (handle|run|manage) (that|sales|the))\b/i;

/**
 * Provider-level endedReasons that mean the call never became a conversation.
 * These are authoritative — no need to read the transcript.
 */
const TERMINAL_REASONS: Record<string, { outcome: CallOutcome; retire?: boolean }> = {
  'customer-did-not-answer': { outcome: 'no_answer' },
  'customer-busy': { outcome: 'no_answer' },
  'customer-did-not-give-microphone-permission': { outcome: 'no_answer' },
  'voicemail': { outcome: 'voicemail' },
  'assistant-said-end-call-phrase': { outcome: 'reached_someone' },
  'twilio-failed-to-connect-call': { outcome: 'failed' },
  'pipeline-error': { outcome: 'failed' },
  'assistant-error': { outcome: 'failed' },
  // Carrier-level rejections mean the number itself is unusable.
  'customer-rejected': { outcome: 'bad_number', retire: true },
  'invalid-destination': { outcome: 'bad_number', retire: true },
};

const NEXT_ACTION: Record<CallOutcome, string> = {
  reached_decision_maker:
    'You spoke with a decision maker. Record what they committed to, book any meeting they agreed to, and set the follow-up they asked for. Do NOT re-dial this lead on a cadence — continue the specific thread that was opened.',
  reached_someone:
    'A human answered but was not the decision maker. Record who you spoke to and anything they revealed (the right name, the best time, a direct extension), then schedule one more call targeting that person specifically.',
  gatekeeper:
    'You were blocked before reaching the target. Save whatever the gatekeeper revealed (the decision maker\'s name, when they are on the floor, a direct line) on the lead, then schedule the next call for the window they suggested — not on a fixed cadence. If the same lead has been gatekept twice, switch channel: email or a social DM to the named person instead of dialling a third time.',
  callback_requested:
    'They asked to be called at a specific time. Schedule a Caller job for that time — this is the highest-value follow-up there is, so get the time right and do not also email them in the meantime.',
  voicemail:
    'Voicemail. Do not immediately re-dial. Follow up on another channel (email or contact form) referencing that you called, and let the cadence bring the next call round.',
  no_answer:
    'No answer. Leave the cadence to schedule the next attempt at a DIFFERENT time of day than this one — re-dialling the same slot repeatedly is how a number gets ignored.',
  wrong_number:
    'Wrong number for this business or person. Clear the bad phone from the lead, mark the phone gap, and queue enrichment to find a correct one before any further calling.',
  bad_number:
    'The number is disconnected or invalid. Remove it from the lead so nothing dials it again, and queue enrichment for a replacement.',
  not_interested:
    'They said no. Set the lead NOT_INTERESTED with the reason. Do not attempt another channel — a no on the phone is a no.',
  do_not_call:
    'They asked not to be contacted. This is already enforced automatically; confirm the lead is marked do-not-contact and stop all outreach.',
  failed:
    'The call failed on our side, not theirs. This is not a signal about the lead — let the cadence retry, and if it fails repeatedly flag the voice channel for a human to check.',
};

export const LABEL_FOR_OUTCOME: Record<CallOutcome, string> = {
  reached_decision_maker: 'Reached decision maker',
  reached_someone: 'Spoke to someone (not the target)',
  gatekeeper: 'Blocked by gatekeeper',
  callback_requested: 'Callback requested',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
  wrong_number: 'Wrong number',
  bad_number: 'Bad/disconnected number',
  not_interested: 'Not interested',
  do_not_call: 'Asked not to be called',
  failed: 'Call failed (our side)',
};

/**
 * Classify a finished call. endedReason is trusted first because it is the
 * provider's own verdict; the transcript only refines what happened once a
 * conversation actually took place.
 */
export function classifyCall(input: {
  endedReason?: string;
  transcript?: string;
  summary?: string;
}): ClassifiedCall {
  const reason = (input.endedReason || '').toLowerCase();
  const text = `${input.transcript || ''}\n${input.summary || ''}`;

  const build = (outcome: CallOutcome, over?: { retireNumber?: boolean; optOut?: boolean }): ClassifiedCall => ({
    outcome,
    retireNumber: over?.retireNumber ?? false,
    optOut: over?.optOut ?? false,
    nextAction: NEXT_ACTION[outcome],
    label: LABEL_FOR_OUTCOME[outcome],
  });

  // An explicit "stop calling" outranks everything, including a provider reason.
  if (DO_NOT_CALL_RE.test(text)) return build('do_not_call', { optOut: true });

  const terminal = TERMINAL_REASONS[reason];
  if (terminal) {
    // A short call that ended normally but has no dialogue is effectively no answer.
    return build(terminal.outcome, { retireNumber: !!terminal.retire });
  }

  // From here a conversation happened; read what kind.
  if (WRONG_NUMBER_RE.test(text)) return build('wrong_number');
  if (NOT_INTERESTED_RE.test(text)) return build('not_interested');
  if (CALLBACK_RE.test(text)) return build('callback_requested');
  if (GATEKEEPER_RE.test(text)) return build('gatekeeper');
  if (DECISION_MAKER_RE.test(text)) return build('reached_decision_maker');

  // Someone talked to us and none of the specific patterns matched.
  if (text.trim().length > 120) return build('reached_someone');
  return build('no_answer');
}

/** Outcomes where dialling again soon is counterproductive or pointless. */
export function shouldPauseCalling(outcome: CallOutcome): boolean {
  return ['not_interested', 'do_not_call', 'bad_number', 'wrong_number'].includes(outcome);
}
