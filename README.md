# Social Engine

AI-first lead prospecting, outreach, and follow-up platform. Talk to the **Engine** — an AI
that researches the internet for prospects, builds deduplicated lead lists with enriched
contacts, runs multi-channel campaigns (email, SMS, voice), and autonomously schedules its own
follow-ups over long periods of time.

> "Get me a list of every automotive dealership in Florida, find the decision makers and their
> contact info, and start reaching out with our offer. Follow up until they respond."

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full vision, agent design, data model,
and build phases.

## Stack

- **Frontend:** Angular 17, custom SCSS design system (light/dark themes), bootstrap-icons, chart.js
- **Backend:** Node.js + Express + TypeScript, Prisma ORM, PostgreSQL
- **AI:** Anthropic / OpenAI tool-calling agent loop with platform-control tools
- **Channels:** Mailgun or a connected Gmail inbox (email), Twilio (SMS), Vapi / OpenAI Realtime (voice) — phased in

## Getting started

```bash
# install everything
npm run install:all

# configure
cp backend/.env.example backend/.env   # set DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET,
                                        # APP_ENCRYPTION_KEY, SUPER_ADMIN_EMAIL,
                                        # INBOUND_WEBHOOK_SECRET, APP_PUBLIC_URL

# database
cd backend && npx prisma migrate dev && cd ..

# run frontend + backend together
npm run dev
```

- Frontend: http://localhost:4200
- API: http://localhost:3000

Integration keys (AI providers, Mailgun, Twilio, Vapi, web search) are
configured **in-app** on the **Settings → Integrations & API keys** page — each
organization sets its own, stored encrypted. Any of these also work as
environment-variable fallbacks (see `.env.example`).

### Two ways to send email

Each playbook picks how its outreach leaves the building:

- **Mailgun sending domains** — several purpose-bought domains and addresses,
  automatic warm-up, sender pools, and a circuit breaker that pauses a mailbox
  that starts bouncing. Built for volume.
- **A connected Gmail inbox** — one real address, sending as the person who owns
  it, replies landing where they already read mail, follow-ups staying inside
  the same thread. Built for the handful of hand-researched emails a day that get
  answered because a person clearly wrote them.

Both are managed on the **Sending** page; the choice is made per playbook. The
Gmail route is connected over Google's own consent screen (no password is ever
typed into Social Engine) and needs a one-time OAuth client set up in Google
Cloud — see [docs/GMAIL_SETUP.md](docs/GMAIL_SETUP.md).

Platform-wide controls live on a separate **Admin** page, in the sidebar only
for the account whose email matches `SUPER_ADMIN_EMAIL`: every organization with
its usage and 7-day spend, per-org pause / daily-cap / social-autonomy levers,
user suspension and role changes, and the Engine limits (max iterations, worker
concurrency, per-org concurrency, poll interval).

## Repository layout

```
backend/    Express + Prisma API, Engine agent loop, scheduler worker
frontend/   Angular app (Dealegent-derived design system)
docs/       Architecture and planning docs
```
