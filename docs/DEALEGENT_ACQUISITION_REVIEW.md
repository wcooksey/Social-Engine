# Dealegent outreach review — September 7, 2026

## Observed at approximately 7:29 PM Eastern

- First Maryland campaign: 30 approved first emails, 25 sent, 5 still queued.
- Mailgun logs confirm delivery for all 25 sent dealership emails. An earlier
  failure to a `scale.sandbox` test address belongs to another send, not this batch.
- Both selected mailboxes have matched delivery feedback in Social Engine.
  No recorded bounce or complaint for either outreach mailbox; missing failure
  and complaint test receipts mean those paths are not yet proven end to end.
- No dealership replies recorded in the campaign at this check. Delivery does
  not prove inbox placement or interest. Open tracking is disabled.
- The campaign contains one fixed first email and waits at the end. No automatic
  follow-up step is currently approved.
- Quiet hours begin at 8 PM Eastern. Another 30 cannot fit tonight at the
  existing pacing. Keep the current caps and queue safeguards.

Campaign: https://app.neuralneticsai.com/campaigns/8d7c0470-136f-4d99-8a09-e84a45491e15

## Configuration correction during the audit

Settings → Check reply tracking passed for both outreach domains: verified MX
and a matching inbound route to the correct application with the expected secret.
The new delivery-reporting check identified missing `temporary_fail` destinations
on both domains. Used Connect delivery reporting; the app verified all four event
types (delivered, temporary failure, permanent failure, complaint) configured for
both domains. No synthetic failure or external test message was sent.

At approximately 7:38 PM the first batch had 27 sent and three messages still
queued: Wantz Chevrolet, Waldorf Cadillac Sales, and Waldorf Toyota. These counts
are snapshots; the live queue continues under the existing pacing and quiet hours.

## Customer-facing friction found

Reviewed https://app.dealegent.com/home and followed its live sandbox link.

1. The public Results section exposes placeholders: “Add a real metric and
   quote from your reporting” and “Store type, region.” Remove this unfinished
   section until there is real customer evidence; do not invent metrics.
2. The public page positions Dealegent as a CRM replacement. Avoid the existing
   voice playbook's claim that it simply layers on top of the customer's CRM
   unless an actual integration supports that offer.
3. The “No signup” sandbox link reaches a mobile-number and automated-marketing
   SMS consent gate. Do not describe this as frictionless browsing. A short video
   or guided screen share is a lower-commitment next step for an email prospect.
4. “Book a demo” opens a request form, not a calendar with available times. Its
   successful submission and owner notification have not been tested in this audit.

No public website changes or test SMS submissions were made during this review.

## Proposed sales workflow for review

Second batch saved in Social Engine:
https://app.neuralneticsai.com/campaigns/211db0df-f0ed-4ba3-ac8d-7dcf842615b2

Independently inspected: DRAFT, APPROVAL_REQUIRED, EMAIL only, 30 enrolled NEW
leads, zero touches, no sends. Engine checked prior histories and exact-address
Mailgun results, excluded the first batch, and deduplicated IAD's shared owner
address. The reviewed first email is now saved as the campaign's single approved
fixed step. A campaign-scoped playbook named “Maryland batch 2 — 30 emails —
September 8” enforces the two-mailbox pool and prohibits extra enrollment,
additional channels, repeats, or bypassing warm-up safeguards. The campaign was
left DRAFT, so no messages can be generated or sent tonight.

Readiness at 7:56 PM Eastern assessed all 30 of 30 leads as currently verified
with no lead-level hold. It passed sender selection, playbook routing, and postal
footer checks. Both pool mailboxes were ACTIVE at 15 of 40 used today, with zero
recorded bounces or complaints. The report remained blocked only because every
matched campaign was inactive. Reply and unsubscribe configuration is present,
but the UI correctly labels a controlled round-trip test as still unproven.

- Select one decision-maker per new dealership; check prior contact across
  campaigns, exact-address verification, suppression and replies before sending.
- Start with a concrete problem: handling and following up with internet leads.
  Do not promise unproven sales improvements or imply a CRM integration.
- Positive reply: stop cold outreach across channels, respond in the same email
  conversation with the promised demonstration, and ask for a short walkthrough.
- No reply: review one follow-up after three business days. Do not append it to
  an active campaign until its exact copy and timing are approved.
- Track delivered → human replies → interested replies → demo booked → demo
  held → customer. Compare batches by these outcomes rather than open rates.

### Saved first email — approved fixed copy, campaign inactive

Subject: Following up with dealership leads

Hey there,

I built Dealegent, a dealership CRM that helps respond to internet leads, keep
following up, and book appointments.

Would it be useful if I sent a short video showing how it works?

### Candidate follow-up — not approved or scheduled

Subject: Re: Following up with dealership leads

Hey there,

Following up on my note about Dealegent. It's designed to keep working internet
leads after the first conversation, so your team can focus on buyers who are
ready for a visit.

Are you the right person to speak with about lead follow-up at your dealership?

The platform must append the actual sender signature, postal address and
unsubscribe controls. Keep the existing first batch's approved copy unchanged.
