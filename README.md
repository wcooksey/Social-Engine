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
- **Channels:** Mailgun (email), Twilio (SMS), Vapi / OpenAI Realtime (voice) — phased in

## Getting started

```bash
# install everything
npm run install:all

# configure
cp backend/.env.example backend/.env   # set DATABASE_URL, JWT_SECRET, ANTHROPIC_API_KEY, ...

# database
cd backend && npx prisma migrate dev && cd ..

# run frontend + backend together
npm run dev
```

- Frontend: http://localhost:4200
- API: http://localhost:3000

## Repository layout

```
backend/    Express + Prisma API, Engine agent loop, scheduler worker
frontend/   Angular app (Dealegent-derived design system)
docs/       Architecture and planning docs
```
