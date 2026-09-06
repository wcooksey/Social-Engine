# Outreach readiness and explicit sequences

Implemented locally; apply the migration and deploy before these controls appear in production. No live sending tests or production configuration changes were made during implementation.

## Operator workflow

1. Open **Playbooks → Check readiness**. The Engine uses the same report through `get_playbook_readiness`. It separates blocked, unconfirmed and informational checks and reports the assessed audience size, candidate sender, related campaigns, recent activity, mailbox allowances and event-ingestion evidence.
2. Resolve sender configuration, exact-address verification and sender postal footer. Verification expires after 30 days; unavailable/unknown validation does not qualify. Sender SPF and DKIM must be confirmed for managed Mailgun mailboxes. Provider permission and DMARC/alignment remain explicit external checks, not inferred from a working API key.
3. On a draft or paused campaign with no prior messages or touches, append email steps. Each has a subject, fixed body, delay after the preceding send and approval state. Draft steps can be edited; approved steps are immutable. Approval-required campaigns still require each generated message to be approved in Inbox.
4. Use **Preview without sending** on an enrolled lead. It checks the planned next step, sender, verification, holds and limits without provider requests or writes.
5. Test real delivery only with an approval-required campaign containing inboxes you own. Approvals queue through the normal safeguards. Verify delivery/authentication, reply ingestion and unsubscribe handling on separate test contacts. The Settings connectivity test remains a real send that bypasses campaign pacing; it is not an end-to-end campaign test.

Appending approved steps to an active autonomous campaign makes those steps eligible for existing unreplied leads at their current position. Old steps are not replayed. A sequence waits when approved steps run out, disables repeat cycles, and is email-only. Existing AI-cadence campaigns are not silently converted. A unique persisted key prevents concurrent sequence sweeps from composing the same lead/step twice. Cancelled or expired steps are not regenerated automatically; inspect their message status rather than assuming they were delivered.

Human replies establish a lead-level hold across campaigns/channels and cancel pending prospecting. The Engine can continue the conversation on the responding channel; it cannot switch channels automatically. Explicit human messages remain intentional actions, but email still checks verification, suppression, caps and pacing. There is no automatic release of the engagement hold. Automated replies retain the existing cadence deferral behavior.

Warm-up growth is bounded by elapsed days and prior UTC days with actual sends. Idle days do not advance the ramp. Health pauses require explicit review/resume. There is no claim of inbox placement or earned reputation from a status label. Open tracking remains disabled and is labeled unavailable. New matched webhook receipts establish event-ingestion evidence only; they do not establish complete per-domain reporting. Readiness intentionally remains unconfirmed for external checks it cannot prove.

## Rollout

- Coordinate worker shutdown/pause while deploying; do not run mixed backend versions across the schema transition.
- Apply `backend/prisma/migrations/20260906010000_outreach_safety/migration.sql` through the normal `npm run prisma:deploy` workflow from `backend`, regenerate Prisma, and deploy the backend and frontend together. This was **not applied to the live database** by this implementation.
- Existing email verification timestamps have no address binding and deliberately do not qualify until a successful new validation stamps `emailVerifiedAddress`. No existing address is marked verified by assumption.
- Existing ENGAGED, INTERESTED, CUSTOMER or REPLIED leads are backfilled with a cold-outreach hold. Their channel is unknown until a new human reply; automation cannot guess the channel.
- Legacy Mailgun settings remain usable for transactional mail. Cold outreach now requires registered/verified mailboxes; adopting a domain starts WARMING rather than presuming prior reputation.
- All existing health pauses stay paused. Resuming one restarts warming rather than bypassing the ramp.
- Keep the rollout paused until an owned-inbox controlled test confirms real webhook, reply and unsubscribe behavior. Provider permission is an independent requirement; Mailgun remains installed and supported.

## Validation

- `npm run build` (backend and production Angular build).
- `cd backend && npx prisma validate`.
- `cd backend && npm run test:outreach`: verification binding/freshness, suppression, channel holds, late replies, enrollment checks, no campaign-ID bypass, idle warm-up, DNS enforcement, sequence exhaustion and concurrent/repeated sequence sweeps. Database/provider calls are mocked; this is not a live PostgreSQL migration or provider integration test.
- Chrome visual and interaction checks against a local fixture-only server for readiness, sequence controls and no-send preview. No production records or provider requests were used.
