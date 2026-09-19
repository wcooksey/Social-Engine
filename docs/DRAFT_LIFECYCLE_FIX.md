# Blocked draft lifecycle fix

## Behavior

- Engine campaign email now persists through the outbound queue, with a unique campaign/lead/cycle/touch key. Concurrent/repeated attempts reuse that message instead of composing another draft or sending directly.
- Fixed sequences retain their existing unique campaign/lead/step keys and approved copy. The Engine cannot rewrite them.
- Quiet hours schedule the next local opening (DST-aware); the daily cap schedules the next day, with all send checks repeated before delivery.
- Organization pause and unreachable public-URL configuration are non-retryable blockers. Approval-required campaigns remain drafts. Opt-outs, suppression, email verification and active-conversation checks remain enforced.
- Messages now store `blockedReason` and `retryable`. Inbox displays the reason and retry behavior; old drafts explicitly say their reason was not recorded.
- Successful queue sends retire older exact-match campaign drafts. Draft approval and queue dispatch reject a duplicate whose equivalent message was already sent.

## Conservative cleanup

Campaign page → Older drafts → Check duplicate drafts provides a read-only preview, followed by a separate cancellation action. It requires the same recipient conversation, campaign, exact subject and body, and a successful send at or after draft creation. Distinct known sequence steps, standalone replies, changed copy, unsuccessful sends, and uncertain matches are excluded.

Cancellation rechecks records and conditionally changes only the still-unsent draft. It retains history and writes an activity entry referencing the successful message. No message is sent; no suppression or enrollment state is changed. There is no blanket migration that cancels all blocked drafts.

Alternative for an operator with the intended database configured, from `backend`:

```
node --import tsx scripts/reconcile-drafts.ts ORGANIZATION_ID CAMPAIGN_ID
node --import tsx scripts/reconcile-drafts.ts ORGANIZATION_ID CAMPAIGN_ID --apply
```

The first command is a dry run; inspect it before applying. The apply run recomputes and rechecks exact matches. Do not use development results as evidence of production cleanup.

## Rollout

1. Apply additive migration `20260919160000_message_block_reasons` before starting the updated server. Railway's existing start command runs `prisma migrate deploy` before `npm start`.
2. Generate Prisma client and build backend/frontend. This patch was integrated onto current main, preserving group workspaces, provenance, reply tracking, campaign continuation and pagination.
3. Open the actual Maryland campaign and preview duplicate drafts. Review the matched records, cancel confirmed duplicates, then recheck remaining count. Do not approve blocked drafts as a cleanup operation.
4. Verify a queued temporary block has its reason and retry time, and that no draft is recreated for the same touch.

The original development workspace uses localhost / se_dev; it is not the production dataset. No production migration, deployment or cleanup has been executed by this change.

## Validation

Run the outreach suite including `tests/draft-lifecycle.test.ts`, backend TypeScript build and frontend production build. Tests cover exact-match exclusions, tenant scoping, concurrent attempts, approvals, suppression, repeat cycles, fixed-sequence ownership, quiet-hour/DST scheduling, daily caps, and cancellation races. Tests stub database/providers; production delivery has not been exercised.
