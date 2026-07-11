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
concurrency, per-org concurrency cap, and worker poll interval — are gated behind a super-admin
section, unlocked only for the account whose email matches the `SUPER_ADMIN_EMAIL` environment
variable. Concurrency changes apply within ~10s (the worker re-reads them each drain); the poll
interval applies on the next restart. Only `DATABASE_URL`, the JWT secrets, `APP_ENCRYPTION_KEY`,
`SUPER_ADMIN_EMAIL`, and `INBOUND_WEBHOOK_SECRET` must live in the environment.

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
| `search_leads` | Query existing leads (dedup checks, targeting) |
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

## Data model (core entities)

- **Organization** — tenant. Users belong to orgs; every record is org-scoped.
- **User** — auth identity (email+password now; Google/Microsoft OAuth later), role (owner/admin/member).
- **LeadGroup** — a named list/segment ("Florida Dealerships"), with `aiSummary` + goal.
- **Lead** — a business/prospect: name, website/domain, address, industry, status
  (new → researching → contacted → engaged → interested → customer / not_interested), dedup keys.
- **Contact** — a person at a lead: name, title, emails, phones, social profiles (JSON), source.
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
