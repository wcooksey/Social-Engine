# Social Engine — Architecture & Vision

## What this is

Social Engine is an AI-first lead prospecting, outreach, and follow-up platform. The core idea:
you talk to an AI (the **Engine**) and it does the work of a team of BDRs — autonomously, over
long periods of time, across multiple channels.

Example of the target experience:

> "Build me a list of every automotive dealership in the state of Florida. Find emails and
> contacts for the important people at each one, plus their social media. Then start a campaign
> with our offer, and follow up on your own schedule until they respond."

The Engine plans the work, researches on the internet, creates leads and contacts (deduplicated),
launches campaigns, sends messages, makes calls, sets its own follow-up schedule, and reports back
with interested leads.

Built for internal use across our companies first, but designed multi-tenant from day one
(organizations + users + auth) so other accounts can use it later.

## Product pillars

1. **Conversational control** — a chat console where you direct the Engine in natural language.
   The Engine has tools to control the whole platform (create lead groups, run research, launch
   campaigns, schedule follow-ups).
2. **Autonomous prospecting** — the Engine researches the open internet (search, website scraping,
   directories, social) to build lead lists with enriched contacts. Dedup and validation are
   built in.
3. **Multi-channel outreach** — email (Mailgun/SMTP), SMS (Twilio), voice calls (OpenAI Realtime /
   Grok voice / ElevenLabs / Vapi), and social touches. Unified conversation timeline per lead.
4. **Autonomous follow-up** — the Engine owns a scheduler. Every touch can spawn a future
   follow-up task; the Engine wakes up, reviews context, and acts.
5. **Long-running memory** — the Engine keeps durable records (notes, summaries, embeddings) so
   context survives across weeks of campaign activity without blowing up any single AI context
   window.

## System overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Angular frontend (Dealegent design system: light/dark themes)  │
│  Dashboard · Leads · Contacts · Campaigns · Conversations       │
│  Engine Console (chat) · Agent Runs · Settings                  │
└───────────────▲─────────────────────────────────────────────────┘
                │ REST + SSE (streaming agent output)
┌───────────────┴─────────────────────────────────────────────────┐
│  Node/Express + TypeScript API                                  │
│  ├─ Auth (JWT, orgs, roles)                                     │
│  ├─ CRM core (leads, contacts, groups, campaigns, activities)   │
│  ├─ Engine service (agent loop w/ tool calling)                 │
│  ├─ Scheduler/worker (follow-ups, agent jobs, campaign sends)   │
│  └─ Channel services (email, SMS, voice, web research)          │
└───────────────┬─────────────────────────────────────────────────┘
                │ Prisma
        ┌───────┴────────┐        ┌──────────────────────────┐
        │  PostgreSQL    │        │  External services       │
        └────────────────┘        │  Anthropic/OpenAI (LLM)  │
                                  │  Search API, scraping    │
                                  │  Mailgun · Twilio · Vapi │
                                  └──────────────────────────┘
```

## The Engine (AI agent layer)

### Multi-provider model layer

The Engine is provider-agnostic. A model catalog routes any model id to its provider by prefix
(`claude-*` → Anthropic native SDK; `gpt-*`, `gemini-*`, `grok-*`, `deepseek-*` → the
OpenAI-compatible wire format with per-provider base URLs). The organization picks its active
model (`Organization.engineModel`) and can switch it on the fly from the Engine console or
Settings. If the active provider errors (outage, rate limit, timeout), the run **fails over
automatically** to the next configured provider mid-loop — the failover is recorded as an
AgentStep and the serving model is stored on the AgentRun. Configure any subset of the provider
keys (Anthropic / OpenAI / Gemini / xAI / DeepSeek) per organization on the Settings page; each
resolves from the saved in-app value first, then the matching environment variable as a fallback.

### Settings & secrets

Integration credentials are per-organization and configured in-app (**Settings → Integrations &
API keys**): AI provider keys, web-search key, Mailgun, Twilio, and Vapi. Secret values are
encrypted at rest with `APP_ENCRYPTION_KEY` (AES-256-GCM) and never returned by the API once
saved — the masked list only reports whether each is set and where it resolves from (`org` DB
value → `env` fallback → `unset`). Resolution precedence everywhere is **DB value → env var →
default**, so existing env-based deployments keep working untouched.

Platform-wide knobs that affect every organization — engine max iterations, global worker
concurrency, per-org concurrency cap, and worker poll interval — live on the **Admin** page,
unlocked only for the account whose email matches the `SUPER_ADMIN_EMAIL` environment variable.
Concurrency changes apply within ~10s (the worker re-reads them each drain); the poll interval
applies on the next restart. Only `DATABASE_URL`, the JWT secrets, `APP_ENCRYPTION_KEY`,
`SUPER_ADMIN_EMAIL`, and `INBOUND_WEBHOOK_SECRET` must live in the environment.

### Admin (super admin)

`/api/admin/*` is the only cross-tenant surface in the API; the whole router sits behind
`superAdminMiddleware`, and super admin is an email match rather than a `Role` — the enum stays
`OWNER | ADMIN | MEMBER`. It exposes platform totals and 7-day spend, an organization list with
usage, the per-org safety levers (pause, daily send cap, social autonomy), and user suspension /
role changes. It deliberately cannot read another tenant's leads, conversations, or integration
keys, and there is no impersonation. Changing a user's role or active state revokes their tokens,
since both are baked into issued JWTs. Because super admin is decided by email, `PATCH /api/auth/me`
refuses to move an existing account onto `SUPER_ADMIN_EMAIL`; claiming it at registration remains
the intended bootstrap.

### Sender identity

Outreach defaults to the organization name, but a playbook can carry a sender identity — person,
title, business, reply-to address, signature — so one account can work several employees or sell
several services without separate organizations. `resolveSenderIdentity` picks it deterministically
at send time (scoped playbook beats GLOBAL, then priority, then age; the winner is used whole), so
the From header, the signature, and the AI's voice-call introduction cannot drift from each other
or depend on the model remembering. A reply-to address is honored only when it sits on the org's
Mailgun sending domain. Inbox replies resolve the same identity, so a thread never changes sender
mid-conversation.

### Hardening

- **Webhooks fail closed.** Inbound reply endpoints (email/SMS/social) reject everything until
  `INBOUND_WEBHOOK_SECRET` is set (timing-safe compare); the Vapi end-of-call webhook requires the
  org's webhook secret. An explicit `leadId` from a bridge must belong to the claimed org, and
  email/SMS contact matching is scoped to the org that owns the receiving address
  (Mailgun domain / Twilio number), so matching never crosses tenants.
- **Deterministic opt-out.** SMS STOP keywords and unsubscribe phrasing hard-flag the lead
  (`doNotContact`) and contact (`optedOut`) in code — no agent is queued, and every send tool
  refuses opted-out leads regardless of what the model decides. Compliance is not left to the AI.
- **Prompt-injection containment.** Inbound message bodies and call summaries are embedded in
  agent objectives as delimited data with an explicit never-treat-as-instructions note.
- **SSRF guard.** `fetch_page` validates every redirect hop and the browser agent blocks requests
  (including subresources) to loopback, link-local/cloud-metadata, and private ranges.
- **Misc.** Query-string tokens/secrets are redacted from access logs; production CORS is
  same-origin unless `CORS_ORIGINS` allows more; platform settings are clamped to sane ranges;
  cross-org foreign keys (groups, campaigns, contacts on events) are validated on write; social
  session upload/delete is OWNER/ADMIN-only.

### Getting meetings booked (autopilot outcome)

- **Calendar invites.** When a meeting is booked, the lead gets an emailed `.ics`
  invite (`METHOD:REQUEST`) that adds to Gmail/Outlook/Apple natively — no OAuth
  integration required. (Two-way Google Calendar API sync is a future add.)
- **Self-serve booking links.** Public, unauthenticated pages at
  `/book/:slug` show slots computed from a link's weekly availability (in the
  link's timezone) minus already-booked events and a configurable buffer.
  Booking creates the lead/contact if new (status `INTERESTED`), drops the event
  on the shared calendar, emails the `.ics`, and alerts the org. The Engine can
  pull active links via the `get_booking_links` tool and drop them into outreach
  so leads self-schedule instead of negotiating a time.
- **Reminders.** A worker sweep sends the lead a 24h and 1h reminder before each
  meeting (respecting opt-out/suppression) and notifies the team — cutting
  no-shows on autopiloted bookings.

### Notifications

In-app notifications plus opt-in email alerts fire on the events a human cares
about: a meeting booked, a hot reply, a lead going `INTERESTED`. A once-a-day
digest summarizes what the autopilot did (meetings, replies, sends, calls). Per
user, `notifyByEmail` controls email; the in-app bell is always available.

### Deliverability & compliance

Outbound email carries a `List-Unsubscribe` header with a signed one-click
unsubscribe link (public route, no login). Mailgun bounce/complaint webhooks
suppress the offending address (`Contact.emailStatus`), and the send tools skip
suppressed or opted-out contacts. Combined with per-lead timezone quiet hours
and the deterministic STOP handling, this keeps volume from wrecking sender
reputation. Sessions are revocable: `User.tokenVersion` (bumped on logout /
password change) invalidates previously issued JWTs at refresh time.

### Systematic lead sourcing (coverage)

Broad objectives ("all dealerships in Florida") don't work as one search — search
APIs return the best ~20 answers, not an enumeration. Instead the Coordinator
plans a **coverage grid**: granular cells (city × brand/category) stored as
`CoverageCell` rows on the target lead group. Researchers **claim cells
atomically** (parallel-agent safe, with stale-claim recovery), run each cell's
query through `source_local_businesses` — the **Google Places API**, which
enumerates up to 60 businesses per query with name/website/phone/address — and
mark cells done with a lead count. Every hit flows through the standard upsert
dedup, so no duplicates across cells or sessions. `list_coverage` makes progress
a database fact: any later session knows exactly what's pending vs. done and
continues where the last one stopped, never re-searching covered ground.
Without a Places key the agent falls back to search_web/browse_web per cell
(less complete). Requires `GOOGLE_PLACES_API_KEY` (org setting or env).

### Contact enrichment

Turning a sourced business into a reachable person uses three complementary
tools, in preference order: `find_contacts_on_website` (deterministic crawl of
the lead's contact/about/team pages — published emails are usually live),
`enrich_contacts_apollo` (Apollo.io people search by company domain + titles;
revealed emails auto-save as contacts), and `verify_email` (Mailgun address
validation — undeliverable addresses are suppressed on the contact BEFORE a
bounce can hurt sender reputation). Requires `APOLLO_API_KEY` for Apollo;
crawl + verification work with just Mailgun.

### Sandbox: rehearsing behaviour, not plumbing

`/api/test` proves the channels work by sending real messages to yourself.
The Sandbox answers a different question — *what will the AI actually say?* —
and answers it without touching anyone.

A run started with `simulate: true` uses the real role, system prompt,
playbooks and tool set, but `executeTool` intercepts anything that isn't
read-only and returns what it *would* have done. The interception list is an
**allowlist of read-only tools**, not a blocklist of senders, so it fails
closed: a tool added later is simulated by default rather than quietly sending.
Verified across all 51 tools — 35 intercepted, and the 16 that execute are
exactly the read-only set, with zero writes to leads, contacts, activities,
messages, calendar events, campaigns, goals or playbooks.

The Conversation tab replays the same objective `inbound.service` gives a real
reply job, so what you see is what a prospect would get, and each turn lists
the actions the Engine would have taken. The Voice tab is the one place
something real happens: it calls *you* with the actual call persona and VOICE
playbooks, and shows the resolved system prompt — the thing to edit when the
bot says something you don't like.

A rehearsal call carries the same mid-call tools a live call gets, so you hear
the bot offer to text a link or book a time. The webhook recognises a rehearsal
(`metadata.sandbox`) and performs no sends and no writes; only
`check_availability` runs for real, because reading the calendar is harmless and
the times it then offers you are genuine ones.

### The phone agent: outcomes, mid-call actions, and a coach

Three pieces, each solving something the others can't.

**Outcomes** (`call-outcome.service.ts`). Vapi returns an `endedReason`, a
summary and a transcript — prose. Every post-call decision used to depend on an
agent reading that and improvising, and nothing could be counted. `classifyCall`
maps it to a fixed taxonomy (reached decision maker, gatekeeper, callback
requested, voicemail, wrong/bad number, not interested, do-not-call, failed),
trusting the provider's `endedReason` first and reading the transcript only once
a conversation actually happened. Consequences are enforced in code, not left to
an agent: a do-not-call sets `doNotContact`, a dead number is cleared from the
lead and re-scored for enrichment, and an opted-out lead gets no follow-up job.

**Mid-call actions** (`call-tools.service.ts`). Vapi delivers `tool-calls` to
the same webhook mid-conversation and speaks the result, so "I'll text that over
right now" happens while they're still on the line rather than ten minutes later
via a follow-up job. Four tools: text a demo/booking link, read real calendar
openings, book (refusing to double-book, notifying the org, emailing the .ics),
and record a callback time as a `CALLER` job.

Two constraints shape it. The SMS destination is **always** the number we
dialled or the one on the lead, never one spoken during the call — the
transcript is untrusted input and a tool that texts arbitrary numbers on request
is an open relay. And tools are gated on what is actually configured, with the
system prompt describing only the ones attached to that call: an assistant told
it can text with no SMS channel promises a text that never arrives, which is
worse than not offering.

**The coach** (`call-coach.service.ts`). Deciding what the bot should *say* is a
different job from executing, so it is a different AI: a plain conversation on
its own model (`Organization.coachModel`, independent of `engineModel` — the
Engine runs all day and is picked for cost, while tuning a script is one
conversation worth the best model available). It sees three things the Engine
never assembles in one place: the verbatim prompt live calls run on, the active
VOICE playbooks, and the outcome distribution of the last 150 calls.

It has exactly one tool, `propose_playbook`, and proposals are **returned, never
applied** — `POST /api/sandbox/coach/apply` is a separate call behind an explicit
click, because changing how every future call is conducted is a decision a person
makes from a diff they can read. Call summaries are wrapped in the coach's prompt
as data from strangers on the phone, never as instructions.

### Run control: runs outlive their request

An Engine run used to *be* its HTTP request — `engineService.run()` was awaited
inside the POST handler with events streaming into that one response. Navigating
away destroyed the stream with no way back, and nothing held a handle on the run,
so it could not be paused or stopped.

Runs are now first-class. `run-registry.ts` holds each in-flight run's indexed
event buffer, its subscribers, and its control state:

- **Start and follow are separate.** `POST /chats/:id/messages` returns a
  `runId` immediately (202) and the run continues in the background;
  `GET /runs/:runId/stream?fromIndex=N` attaches, replays what was missed, then
  live-tails. Attach from any tab or device, as many times as you like. Runs the
  registry no longer holds are replayed from their persisted `AgentStep` rows.
- **The frontend keeps state out of the component.** `EngineSessionService` is
  root-scoped, so navigating away just stops rendering; the thread and the
  stream subscription survive. After a full reload, `GET /chats/:id/live`
  reattaches to whatever is still running.
- **Control happens at checkpoints.** The run loop awaits
  `runRegistry.checkpoint()` before each iteration and before each tool call.
  Pause parks there, cancel throws `RunCancelledError` (recorded as `CANCELLED`,
  keeping partial work — not `FAILED`), and **watch mode** parks before every
  action with a description of what it is about to do, so an operator can watch
  work happen one step at a time and stop it *before* it fires. Because control
  is only observed at checkpoints, stopping never lands mid-tool-call; a cancel
  during a long browser step takes effect when that step returns, and the UI
  says so rather than pretending it is instant.
- **The Live page is fleet view.** Every concurrent agent is a card with its
  role, objective, current step, live tool timeline, browser viewport, and its
  own transport controls — the answer to "what are 300 leads' worth of agents
  actually doing right now?"

### Enrichment quality: categorization & targeted retries

A group of hundreds of sourced businesses is useless if you can't tell which
ones are actually reachable. Every lead therefore carries a **denormalized
enrichment snapshot**, recomputed on every lead/contact write (`scoreLead` in
`lead-enrichment.service.ts` is the single source of truth, mirrored by the
migration's SQL backfill so existing data is graded on deploy):

- **Score** 0-100 from weighted signals — usable email (25), named person (12),
  decision maker (10), verified-deliverable email (10), direct phone (10),
  website (10), company phone (8), location (5), social (5), second email (5).
- **Tier** — `NONE` (no email/phone/social — unreachable), `MINIMAL` (company
  switchboard only, no named person), `PARTIAL`, `GOOD` (a named contact with a
  direct email or phone), `RICH`. Reachability is a hard gate: a lead with a
  great website and no way to contact anyone is `NONE` regardless of score.
- **Counts + gaps** — usable email/phone/contact counts and the exact list of
  missing signals. Suppressed (bounced/complained), unverified-dead, and
  opted-out contacts do not count as reachable, so a lead's tier *drops* when a
  bounce arrives.

Because it's denormalized, the whole list is filterable and countable in SQL:
the Leads page shows clickable tier chips with counts, presets ("needs
enrichment", "no email", "ready for outreach", "2+ emails"), an enrichment
column sortable by score, and per-group enrichment mix bars on the Groups page.
`GET /api/leads/enrichment/stats` returns the breakdown; `POST
/api/leads/enrichment/recompute` rebuilds the columns after a scoring change.

**Retrying with new capabilities without wasting passes.** Each lead records how
many enrichment passes it has had and which `ENRICHMENT_CAPABILITY_VERSION` last
worked it. Agents pick work from `list_enrichment_targets`, which returns only
leads that are weak *and* worth another pass — excluding anything already
GOOD/RICH, opted out, attempted within the cooldown, or already exhausted by the
current toolset — ordered weakest-first with each lead's missing signals
attached. After working a lead the agent calls `record_enrichment_attempt`,
stamping the capability generation used. When the platform gains a new
enrichment ability, bumping `ENRICHMENT_CAPABILITY_VERSION` makes every
previously worked lead eligible again automatically — so "go back over the old
leads with the new tools" is a one-line change and a database fact, never an
agent's memory, and the leads that are already enriched well never get
re-researched.

### Cold DM machine

Researchers find the right account/person on social (browser agent with the
org's persistent login) and save the profile on the lead; SDRs send **one**
personalized cold DM per lead — `send_social_dm` enforces one-per-lead/platform
in code (repeats refused unless explicitly overridden). Replies land through
the inbound webhook and are answered via the conversation API loop, not by
re-DMing. Human-approved drafts dispatch through the browser agent.

### Mechanical campaign cadence

Follow-up persistence is enforced by the system, not agent memory: every send
with a `campaignId` advances that lead's cadence clock (`touchCount`,
`nextTouchAt`); a worker sweep queues **batched** SDR jobs (~15 leads per run,
~10x cheaper than per-lead runs) for leads whose next touch is due. Replies
flip the campaign lead to `REPLIED` (drip pauses, conversation takes over),
max-touches marks it `COMPLETED`, opt-outs are excluded, and a requeue guard
prevents duplicate jobs. Voicemail: AI calls detect machines and leave a
configurable message instead of hanging up.

This sweep is a **generator** — it writes new jobs and new messages rather than
holding them — so the only things that stop it are `CampaignLead.pausedAt` (an
operator hold) and taking the campaign out of `ACTIVE`. See "Scheduled work: one
view, and a brake".

### Scheduled work: one view, and a brake

Five independent mechanisms can put a message in front of a prospect with no
human and no agent present — a queued `Message` waiting on sender pacing, a
pending `AgentJob`, a `CampaignLead` whose next touch is due, an
`AutopilotGoal` re-queueing itself, and the 24h/1h meeting reminders on a
`CalendarEvent`. Each was steered from a different page, or from none.

Two of the five are **generators**, and that distinction is the whole point of
the feature. Campaign cadence and Autopilot goals do not hold a message — they
*write* new jobs and new messages on every sweep. Cancelling their output stops
one copy and nothing else; minutes later the sweep composes a replacement. An
operator who cancelled queued mail and pending jobs and then watched outreach
keep arriving was not looking at a bug so much as at four invisible layers.

The **Scheduled** page reports all five in one feed, keyed by a composite
`KIND:uuid` ref so a single selection can span them, and leads with which
generators are currently running before it shows a row. Every layer gained a
reversible **hold** distinct from a permanent **cancel**:

| Kind | Hold | Cancel |
| --- | --- | --- |
| `MESSAGE` | `status` → `paused` (invisible to the queue drain) | `status` → `cancelled`, logged to the timeline |
| `JOB` | `AgentJobStatus.PAUSED` (invisible to the worker's claim) | `CANCELLED` |
| `CADENCE` | `CampaignLead.pausedAt` — the only field that stops a campaign | `REMOVED` from the sequence |
| `GOAL` | `AutopilotGoalStatus.PAUSED` | `CANCELLED` |
| `REMINDER` | — (pinned to the meeting time) | remaining rule keys marked sent |

Holds survive the sweeps, including the ninety-day dormant re-engagement pass.
Actions come in two shapes: an explicit selection of refs, and a **scope** — a
filter applied server-side with no id list, so "hold this entire campaign"
works when it has four thousand due touches. An unbounded scope requires an
explicit `confirmAll`. A held message keeps ageing, so resuming one past the
queue's three-day expiry reports that it will be dropped as stale rather than
sent.

Agents reach the same machinery through `list_scheduled_work` and
`cancel_scheduled_work`. Before these existed the Engine had a tool to *create*
scheduled work and none to see or stop it, so "cancel my follow-ups" had no
tool behind it at all.

### Cost tracking

Every LLM call's token usage is captured from the provider response and priced
against the model that actually served it (failover-aware) using list prices in
the model catalog (`pricingForModel` / `estimateCostUsd` — update prices there
when vendors change them). Totals accumulate on the `AgentRun`
(`inputTokens`/`outputTokens`/`costUsd`), including the browser sub-agent's
calls, which are attributed back to the parent run. `GET /api/agent/usage`
aggregates totals, per-model, and per-day for the dashboard's AI-spend card;
the runs list shows per-run model + cost. Costs are estimates at list prices
(no cache/batch discounts) — provider invoices are authoritative. Vapi call
minutes and search/enrichment API fees are billed by those vendors and are not
included.

### Conversational setup

The Coordinator can configure the workspace from a chat instruction
("set me up to book demos with FL dealerships"): `get_setup_status` reports
what's configured/missing with suggestions, `create_booking_link` and
`update_org_guardrails` handle scheduling and safety knobs, and campaigns/
playbooks/coverage plans are created through the existing tools. Secrets stay
in Settings — the AI points at what's missing but never handles key values.
The dashboard funnel (`/api/dashboard/funnel`) tracks sourced → contact info →
contacted → replied → interested → booked → completed, per campaign.

### Bulk import

CSV import maps common header aliases (company, website, email, first/last name,
phone, title, city, state, industry) and upserts each row through the same dedup
path the Engine uses, so imports never create duplicates. State fills in the
lead timezone when present.

### Human in the loop

Approval-mode drafts are actionable from the inbox: approve (optionally after editing) to send
with the org's channel creds, or discard. Humans can also reply manually on any EMAIL/SMS
conversation — the message is logged on the same thread and timeline the agents read, so the AI
stays aware of what was said.

### Agent loop

The Engine is an LLM agent loop with tool calling, speaking a normalized chat dialect that the
provider adapters translate. A run works like this:

1. A run starts from either a **user message** in the console or a **scheduled job** firing
   (e.g. "follow up with the Florida dealership group").
2. The Engine gets a system prompt describing its role + org context, plus **tools** (below).
3. It loops: think → call tools → observe results → continue, until it finishes the objective.
4. Every run is persisted (`AgentRun` + `AgentStep` records) so you can audit exactly what it
   did, and the run's summary is written back to memory.

### Engine tools (platform control surface)

| Tool | What it does |
|---|---|
| `search_web` | Search the internet (search API) for businesses, people, pages |
| `fetch_page` | Fetch + extract readable content from a URL (scraping) |
| `create_lead_group` | Create a named group/segment of leads |
| `upsert_lead` | Create or update a lead (dedup by domain/name/phone built in) |
| `upsert_contact` | Add a person to a lead with email/phone/socials |
| `search_leads` | Query existing leads (dedup checks, targeting, enrichment-tier filters) |
| `get_enrichment_stats` | Categorize a list by enrichment quality (tier counts, gaps, what's retryable) |
| `list_enrichment_targets` | The enrichment work list: weak leads still worth a pass, weakest first |
| `record_enrichment_attempt` | Stamp a lead with the capability generation used, so it isn't re-worked |
| `find_business_page` | Find + verify a lead's official social business page (name/city/website match) |
| `submit_contact_form` | Fill a lead's website enquiry form with our reply address, so answers thread back |
| `create_campaign` | Define a campaign (channel mix, message templates, offer) |
| `send_email` / `send_sms` | Send a message through the channel services |
| `place_call` | Kick off an AI voice call |
| `schedule_followup` | Schedule its own future work (self-scheduling) |
| `list_calendar_events` | Read the shared calendar (avoid double-booking) |
| `create_calendar_event` / `update_calendar_event` | Book, reschedule, or cancel meetings/demos/calls with leads |
| `log_activity` / `add_note` | Write to the lead timeline / memory |

Tools are the **only** way the Engine touches data — every mutation is validated, org-scoped,
deduplicated, and logged. That keeps autonomy safe.

### Context management (long-running work)

The context problem: a campaign runs for weeks, but a model context window is finite. Strategy:

- **Database is the source of truth, not the transcript.** Each run starts fresh and pulls what
  it needs via tools (lead timelines, group summaries, campaign status).
- **Rolling summaries.** Every run ends by writing a compact summary (`AgentRun.summary`). Group
  and campaign records keep an updated `aiSummary` field the Engine maintains.
- **Lead timelines.** Every touch/reply/call is an `Activity` row; the Engine reads a lead's
  recent timeline before messaging them, so follow-ups are always informed.
- **Chunked work.** Big objectives ("every dealership in Florida") are decomposed into `AgentJob`
  rows (e.g. per-metro research jobs) processed by the worker over time — no single giant run.

### Specialist roles & parallel execution

The Engine runs under a **role** that scopes its tools and persona, so work divides like a real
team while everyone shares the one database brain:

- **Coordinator** — generalist, all tools; drives live chat and orchestrates by delegating.
- **Researcher** — prospect/enrich/dedup via web + browser; no outbound sending.
- **Caller** — places AI voice calls and books meetings.
- **SDR** — email / SMS / social outreach.

Every specialist can `schedule_followup` with a target role, so agents hand work to each other
(a Researcher finishes enrichment → schedules an SDR outreach job → a Caller books the demo).

The **worker runs a concurrency pool**: up to `ENGINE_WORKER_CONCURRENCY` agents at once globally,
capped at `ENGINE_ORG_CONCURRENCY` per organization (so parallelism can't exceed rate limits or
let one org starve another). Jobs are claimed atomically (no double-run), leads dedupe on write,
and the timeline is append-only — so a Researcher, a Caller, and an SDR can work the same lead
pool simultaneously without conflict.

### Autonomy & scheduling

- A **worker loop** polls for due `AgentJob`s (follow-ups, campaign steps, research chunks) and
  executes them as role-scoped Engine runs, several in parallel.
- The Engine can call `schedule_followup` to create future jobs (and delegate them to a role) —
  this is how it "sets its own schedule" and divides labor.
- Guardrails: per-org daily send caps, quiet hours, channel rate limits, kill switch
  (pause org/campaign), and human-approval mode per campaign (draft-first vs. autonomous).
- Everything scheduled is visible and reversible from the **Scheduled** page — see
  "Scheduled work: one view, and a brake".

## Data model (core entities)

- **Organization** — tenant. Users belong to orgs; every record is org-scoped.
- **User** — auth identity (email+password now; Google/Microsoft OAuth later), role (owner/admin/member).
- **LeadGroup** — a named list/segment ("Florida Dealerships"), with `aiSummary` + goal.
  Deleting one does NOT delete its leads: `Lead.group` is `SetNull`, so a list is a view over
  leads rather than their owner. Those leads become **ungrouped** — still counted, still
  enrichable — and are reached through the `groupId=none` sentinel (an "Ungrouped" entry on the
  Leads filter, and a card on the Groups page). Without that route in, deleting a group looked
  like it had done nothing: the leads vanished from every list while every total stayed put.
  `DELETE /api/lead-groups/:id?withLeads=true` is the other intent — destroy the leads with the
  list — and the UI asks which one you mean rather than assuming.
- **Lead** — a business/prospect: name, website/domain, address, industry, status
  (new → researching → contacted → engaged → interested → customer / not_interested), dedup keys,
  plus the enrichment snapshot (score, tier, email/phone counts, gaps, attempts, capability version).
- **Contact** — a person at a lead: name, title, emails, phones, social profiles (JSON), source.
  `emailStatus` is suppression-only (any value = do not send); a confirmed-good
  address is stamped on `emailVerifiedAt`.
- **Campaign** — outreach program: target group, channel sequence, templates/offer, mode
  (autonomous | approval-required), status.
- **Activity** — timeline event on a lead: email_sent, email_reply, sms, call, note,
  status_change, research; includes channel payloads.
- **Conversation / Message** — threaded messages per lead+channel for the unified inbox.
- **AgentRun / AgentStep** — every Engine execution and each tool call within it (audit trail).
- **SocialAccount** — a persistent, per-org social login (LinkedIn/Facebook/Instagram/X):
  an encrypted Playwright storageState (cookies + localStorage). Captured once via a local
  login helper, reused by the browser agent for every lead (no per-lead login), and
  auto-refreshed on each use so it stays alive for weeks.
- **AgentJob** — scheduled unit of work (type, payload, runAt, status) — the scheduler's queue.
  `PAUSED` is an operator hold: the row keeps its objective and `runAt` but the worker's
  claim query cannot see it.
- **CalendarEvent** — shared calendar (meetings/demos/calls with leads); both humans and the
  Engine read and write it. Events booked by the Engine carry the AgentRun id for auditability.
- **EngineChat / EngineChatMessage** — the user↔Engine console threads.

## Channels (integration roadmap)

| Channel | Provider | Phase |
|---|---|---|
| Email | Mailgun (Dealegent already has patterns) / SMTP | 1 |
| Web research | Search API (Brave/Serper/Tavily) + fetch/scrape | 1 |
| SMS | Twilio | 2 |
| Voice | Vapi (proven in Dealegent) → OpenAI Realtime / ElevenLabs / Grok voice | 2–3 |
| Social | LinkedIn/Facebook/Instagram touches (research first, messaging later) | 3 |

## Build phases

**Phase 0 — Foundation (this scaffold)**
Monorepo (Angular 17 frontend + Express/Prisma backend), Dealegent design system (light/dark),
auth with orgs (JWT), CRM core (groups/leads/contacts/campaigns/activities), Engine console UI,
agent loop skeleton with the core CRM tools + web research stubs, AgentRun/AgentJob persistence,
worker loop.

**Phase 1 — Research + Email**
Real search API + scraper, lead enrichment pipeline, dedup hardening, Mailgun sending +
inbound reply webhooks, campaign sequences, follow-up scheduling end-to-end.

**Phase 2 — SMS + Voice + Inbox**
Twilio SMS with two-way threading, Vapi/OpenAI voice calls with transcripts into the timeline,
unified inbox UI, reply classification (interested / not interested / OOO) driving status.

**Phase 3 — Full autonomy**
Long-horizon campaign management, social channel research/touches, analytics dashboard,
multi-account polish (billing hooks, invites), model routing (cheap models for research,
strong models for messaging/judgment).

## Key decisions

- **Same stack as Dealegent** (Angular 17 + Express + Prisma + Postgres) — we know it, we can
  share patterns and deploy the same way (Railway single service).
- **No external queue initially** — `AgentJob` table + polling worker keeps ops simple; can swap
  to BullMQ/Redis when volume demands.
- **Tool-mediated autonomy** — the AI never gets raw DB access; everything is a validated,
  logged, org-scoped tool. This is the safety and auditability backbone.
- **SSE for streaming** — Engine console streams agent thinking/tool activity live.
