# Connecting a Gmail inbox

Social Engine can send a playbook's email one of two ways:

- **Mailgun sending domains** — volume infrastructure. Several purpose-bought
  domains, many addresses, an automatic warm-up ramp, sender pools, and a
  circuit breaker that pauses a mailbox when it starts bouncing. Built for
  thousands of sends a week and for domains that are expected to wear out.
- **A connected Gmail inbox** — one real address, sending as the person who owns
  it, with replies landing where they already read mail. Built for the twenty
  hand-researched emails a week that get answered *because* they came from a
  person.

The choice is **per playbook** (Playbooks → edit → *Send email through*), so one
account can run both at once: a high-volume campaign off bought domains and a
careful one out of a personal inbox, without either borrowing the other's
sender.

This page covers the one-time Google setup. It is a human task — the Engine
cannot do it, because it involves a Google account you own.

---

## 1. Create a Google Cloud project and enable the Gmail API

1. Go to <https://console.cloud.google.com/> and create a project (or pick an
   existing one).
2. **APIs & Services → Library** → search for **Gmail API** → **Enable**.

## 2. Configure the OAuth consent screen

**APIs & Services → OAuth consent screen**

- **User type: External** is what you want unless every inbox you will ever
  connect belongs to the same Google Workspace organization (then Internal is
  simpler and skips everything about verification below).
- Fill in the app name, your support email, and the developer contact.
- **Scopes**: add `https://www.googleapis.com/auth/gmail.modify`. That single
  scope covers everything Social Engine does — read the inbox for replies, send,
  and change labels — while still refusing permanent deletion, so a bug here
  cannot destroy your mail.
- **Test users**: add every Google account you intend to connect.

### About verification

`gmail.modify` is what Google calls a **restricted** scope. An app offering it to
the general public needs to pass Google's verification review (including a
security assessment). **You do not need that to connect your own inboxes.** Leave
the app in **Testing** and add each inbox as a test user: it works indefinitely,
with the only cost being an "unverified app" interstitial on the consent screen
(click *Advanced → Go to …*) and, on some accounts, a refresh token that expires
after seven days — reconnect from the Sending page if that happens to you.

If you are running this as a product for other people's inboxes, verification is
not optional. Plan for it.

## 3. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**

- **Application type: Web application.**
- **Authorized redirect URIs**: add exactly

  ```
  https://<your APP_PUBLIC_URL>/api/public/gmail/callback
  ```

  The Sending page prints the exact string for your deployment — copy it from
  there rather than typing it. A mismatch here is by far the most common reason a
  connection attempt fails, and Google's error says so plainly
  (`redirect_uri_mismatch`).

- Copy the **client ID** and **client secret**.

## 4. Paste them into Social Engine

**Settings → Integrations & API keys → Email**

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`

These are the *app's* credentials, not an inbox's. They never give access to any
mailbox on their own. Both also work as environment variables if you would rather
seed them at deploy time.

`APP_ENCRYPTION_KEY` must be set — connecting an inbox is refused outright
without it rather than storing OAuth tokens in plaintext.

## 5. Connect the inbox

**Sending → Gmail inboxes → Connect an inbox.** You are sent to Google's own
consent screen, you approve, and you land back on Social Engine.

No password is ever typed into Social Engine. What is stored is an OAuth refresh
token, encrypted at rest with `APP_ENCRYPTION_KEY`. You can revoke it at any time
from <https://myaccount.google.com/permissions> or by disconnecting the inbox
here, which revokes it with Google as well.

## 6. Point a playbook at it

**Playbooks → edit → Send email through → A Gmail inbox.**

---

## What changes on the inbox route

| | Mailgun domains | Gmail inbox |
|---|---|---|
| Volume shape | many addresses, rotated | one address |
| Ramp | automatic warm-up, grows daily | none — a flat daily cap |
| Daily ceiling | per-mailbox allowance | per-inbox cap (default 40) |
| Pacing | hourly cap + jittered gap | minimum gap between sends |
| Replies | Mailgun route → webhook | polled from the inbox each sweep |
| Bounces / complaints | webhooks drive a circuit breaker | Google reports neither |
| Threading | recipient's mail client | inside the real Gmail thread |
| Setup | DNS records, MX, a route, a secret | one consent screen |

A few consequences worth knowing:

- **The cap is deliberately low.** Google's own limit is roughly 500/day for a
  personal account and 2,000 for Workspace, and hitting it locks sending for
  about 24 hours. The default of 40 is a prospecting cap, not a technical one —
  raise it on the Sending page if you need to, up to 400.
- **There is no circuit breaker here**, because Gmail tells us nothing about
  bounces or spam complaints. On the Mailgun route those events pause a bad
  mailbox automatically. On this route, your own inbox reputation is yours to
  watch.
- **Replies are polled, not pushed.** The worker reads each connected inbox every
  sweep, so a reply threads onto its lead within a few minutes rather than
  instantly. Only mail from an address that matches a lead in your account is
  ingested — the rest of the inbox is left alone and never stored.
- **Threads are sticky.** A conversation stays with the inbox that started it,
  even if you later retarget the playbook. Switching transport moves *new*
  conversations only.
- **Over cap, nothing is lost.** A message written when the cap is spent is
  queued with a due time and sends itself when the inbox frees up, exactly as it
  does on Mailgun. Never rewrite or resend a message that came back queued.
- **An inbox whose grant Google revokes** goes `EXPIRED`, and playbooks using it
  draft their email instead of sending it. Reconnect from the Sending page.

## If it does not work

| Symptom | Cause |
|---|---|
| `redirect_uri_mismatch` | The URI in Google Cloud is not character-for-character the one on the Sending page. Check the scheme, the host, and the trailing path. |
| "Google issued no refresh token" | The app already holds a consent for this account. Remove it at <https://myaccount.google.com/permissions> and connect again. |
| "Google did not grant the permissions this needs" | A box was unticked on the consent screen. Reconnect and leave them all on. |
| Inbox goes `EXPIRED` after a week | A Testing-mode app on some account types issues seven-day refresh tokens. Publish the app, or reconnect when it lapses. |
| Replies are not threading onto leads | The sender's address must match a contact, or their company domain must match a lead. Free-mail domains (gmail.com, outlook.com…) are never matched by domain — they identify nobody. |
| Nothing sends and the playbook drafts instead | Check the inbox's status on the Sending page; the draft's reason names the blocker. |
