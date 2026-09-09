# Group workspace

Groups are the home page and durable workspace. The existing tools are reused within a connected workflow: overview, Engine/activity, find/qualify, outreach, replies. Outreach connects preparation (playbooks), previews/rehearsal, campaigns, and experiments. Global tools remain available separately. Group URLs own the context; switching groups resets the visible child workspace without cancelling server-side runs.

## Actual relationships

- A campaign belongs in a group view when its auto-enrollment group matches or one of its enrolled leads currently belongs to the group. Campaigns can span groups. Lead detail rows are scoped; campaign-wide settings, sequence steps, schedule and totals are explicitly shared.
- Playbooks are applicable guidance, not campaign parents. Group views include global/status rules plus relevant group and campaign rules. Exact application still depends on the lead and channel. Editing shared rules affects other groups.
- Experiments may target a group, campaign, or neither. Shared/legacy experiments are labelled. Fixed sequences use approved copy; they do not automatically allocate variants. Engine-directed sends must select and carry a variant, with tenant/group/campaign/channel validation before delivery. Existing campaigns are not merged or reinterpreted as an A/B test.
- Engine chats now have an independent group reference. The migration backfills only chats whose playbook directly identifies an owned group. Ambiguous legacy chats remain globally accessible. New group runs and attributable background runs carry a group ID; historical and multi-group campaign runs without a single reliable group remain in aggregate Live.
- Inbox shows current lead group separately from the new compose-time provenance snapshot. Future Engine email/SMS and sequence messages record source, group, selected/routing playbook names and IDs, source run or sequence step, and the recorded basis for selection. Campaign/variant relations remain authoritative. Manual replies identify their human source. Legacy, voice and social records can lack this snapshot; the UI does not invent one. An Engine run's objective/result can be read inside the thread.

## Safe testing and limits

The existing campaign preview is reused inside the group test stage. It reads the approved sequence copy through the existing production step/signature helpers and reports blockers without creating messages. Reply rehearsals share the inbound SDR objective builder, use the same Engine role/prompt machinery, and intercept sending and CRM-writing tools. Simulated send-tool content is shown separately from the assistant's summary. Diagnostic runs/steps are still stored.

This does not prove delivery, inbox placement, every scheduling gate, or LLM behavior. The existing Settings test bench is linked for a user-supplied real recipient; that test proves provider plumbing, not generated-copy parity. Voice/coach remain in the global sandbox until they can carry reliable group context.

## Migration and validation

Apply `20260909150000_group_workspace` and regenerate Prisma Client before running this version against an existing database. It adds nullable group references to chats/runs and JSON provenance on messages; it does not change campaign status or send outreach.

Validated locally with an isolated PostgreSQL database, paused sample organizations, no provider credentials, and an API process with no scheduler:

- All 35 repository migrations applied to the empty test database.
- Backend TypeScript and production Angular builds passed.
- `npm run test:outreach`: 16 outreach, inbound-health and email-reporting safety tests passed after integration with main.
- `GROUP_WORKSPACE_TEST_DB=1 DATABASE_URL=<isolated-local-db> npm run test:groups`: 15 checks passed, covering combined inbox filters, cross-group/tenant rejection, shared campaigns, chat filing, legacy and new attribution, experiment compatibility, scoped Live, read-only previews and simulated dispatch.
- Browser verified group entry/switching, scoped replies and in-thread Engine provenance, connected outreach navigation, fixed-sequence preview/blockers, group Engine/activity, and 34px rendered select/button controls.

The integration suite creates unique disposable fixture organizations and removes only those organizations. It requires explicit opt-in and a localhost database. Production inspection was read-only; no real mail or calls were sent.

## Workspace polish and settings follow-up

Navigation actions use ButtonComponent's anchor mode (`link`, optional `queryParams` and `fragment`) so ordinary navigation remains accessible and supports opening links in a new tab. Small and normal buttons, inputs and selects have a 34px height and 8px corner radius. Specialized cards and workflow tabs remain navigation elements. The Engine model picker uses SelectComponent, preserves uncatalogued current models, provider-key warnings and rollback after a failed update; this model setting affects the whole organization.

Global tools uses native details/summary with matching 199px row width and aligned icon/label positions, an inset divider and a right-side down/up arrow. Browser checks passed on desktop and at 390px mobile width, including Enter/Space toggling and closing the drawer after navigation.

Campaign settings can edit name, offer, sending mode, cadence, touch limit and repeat passes. Fixed sequences retain step-defined cadence and never repeat automatically. Saving does not change status. These settings affect all enrolled groups. The shared schedule links to global lead details because a scheduled lead can belong to another group.

Quiet hours are organization-wide whole-hour values. The start is inclusive; the end is exclusive; overnight windows work; equal hours disable quiet hours. Outreach guardrails use the lead's saved timezone, then a representative US-state zone, then America/New_York. An invalid saved timezone (or an outbound check with no lead) falls back to server local time in the existing runtime. The UI now offers hourly choices instead of silently discarding minutes. The API rejects invalid hours. Campaigns show a quiet-hour summary and link directly to organization settings with a return button. Settings shortcuts scroll inside the app's actual scroll container.

Browser save/reload checks confirmed campaign cadence, quiet hours and model persistence. All sample values were restored and campaigns remained paused/draft. Integration checks cover shared campaign persistence, sequence preservation, quiet-hour validation and tenant isolation; unit checks cover overnight/equal-hour boundaries and timezone resolution. No scheduler, real provider calls, outbound mail or calls were used.

## Remaining release steps (not performed)

1. Review and integrate this worktree's uncommitted changes with the saved checkout, preserving its separate user edits and resolving any overlap.
2. Back up the deployment database and apply the additive group-workspace migration through the normal release process; generate Prisma Client. This follow-up adds no further schema migration.
3. Build backend/frontend and run the outreach and group suites against an isolated test database. Deploy the matching API and frontend together only after release approval.
4. Smoke-test existing organizations, group switching, campaign settings and quiet-hour navigation. Provider/LLM and real email reply round-trip validation still require configured integrations and an explicitly chosen test recipient before enabling outreach.

Release preparation: integrated main `ba9717c`, preserved its sender-pool and Mailgun reporting changes, and reran all 31 checks plus both builds. Railway configuration generates Prisma at build time and runs `prisma migrate deploy` before API startup. Merge remains held until production recovery access is verified.
