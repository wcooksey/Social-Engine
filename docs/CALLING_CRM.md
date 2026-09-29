# Calling CRM

A caller workspace at `/crm`, with a dedicated login entry at `/crm/login`.
Owner/admin users open **Calling CRM** from the sidebar or a group's **Calling CRM · CSV & access** button. Open **Caller accounts** in the CRM header, or choose a group and expand **Manage caller access**.

The CRM and invitation screens reuse the application’s shared buttons, inputs, selects, cards, badges, CSV preview table, typography, and light/dark theme. Caller navigation remains separate from the workspace.

## Creating caller accounts

Choose **Create caller account**, enter their name and email (their sign-in username), and use the generated password or enter one with at least 12 characters (maximum 72 bytes). Check every group this caller may access; CSV export is optional per group. The current group is preselected when creating an account from a group. At least one group is required at creation.

After creation, copy the sign-in URL, email and password and share them manually. The caller signs in immediately at `/crm/login`; no registration or invitation acceptance is needed. The app does not send an email. Credentials are shown only in the creation dialog and cleared when leaving it; the API never returns passwords or password hashes, and the database stores only a bcrypt hash.

Open **Caller accounts → Edit groups** to change an existing caller's full set of groups and export permissions. Uncheck every group to remove all CRM data access while retaining their account and call history. Callers with no groups remain visible in the account list so access can be restored. Existing workspace accounts are never converted to callers or assigned new passwords by this flow. An email already used by any account cannot be reused (global email uniqueness).

Older one-use invitation links remain valid until expiry or revocation. Pending invitations still appear under the group's access panel, but new accounts use the direct creation flow. Creating an account clears that email's unused invitations within the organization.

Remove access per group at any time. Revocation is checked on every request. Owners and admins can see all groups and manage grants; callers only see explicitly granted groups. Members do not gain CRM management access.

## Calling workflow

Source contacts are read-only in the CRM. Each group uses the shared admin-style lead table with company, location, enrichment, contact, phone, email, status, call count, last-call time, and follow-up columns, plus server pagination. Open a row (or its company button) to view the lead in the shared dialog; closing it returns to the current table page and filters. Select a lead, log a call outcome or note, update the pipeline stage, and set a follow-up date. A call records the signed-in person and timestamp, increments the shared count, and appears in the history. Notes do not increment calls. Team totals show counts and outcomes per caller. Filters include pipeline, company/city/phone search, enrichment tier (Unreachable, Company only, Partial, Good, Fully enriched), and due follow-ups. Enrichment filtering applies to the whole group before pagination and uses the same stored tiers as the admin view. No calls, messages, campaigns or Engine jobs are initiated by the CRM.

Do-not-contact records cannot have more calls logged. Recording a do-not-contact outcome also sets the existing global lead opt-out flag. CRM stages otherwise remain separate from Engine lead stages. History entries retain author names even if an account is later deleted. The detail screen displays the most recent 200 history entries; all entries remain stored.

## CSV

Download group CSV exports all leads in the selected group (not just a filtered page), one row per contact, retaining leads with no contacts. Includes company/address/phone, contact/title/email, verification stamp and address, suppression flags, call totals, pipeline stage and follow-up dates. Quoted UTF-8 CSV includes a BOM and neutralizes spreadsheet formulas. Email presence is not verification or permission to send. Source contact fields are exported as recorded. Owners/admins can open **Upload contacts from CSV**, download a template, choose a file, review the first five rows and recognized columns, and explicitly import it. Uploads accept up to 1,000 contact rows / 1 MB. A Company column is required. Each row can include Company phone, Contact phone, Contact (or First name / Last name), Title, Email, Website, Address, City, State, and Postal code.

Imports update matches only in the selected group. Exported Lead ID and Contact ID fields preserve identity on re-upload; IDs from another group are rejected. Without IDs, leads match on company and location (city, state, address), and contacts match on email or name plus direct phone. Ambiguous matches are rejected. Remove both ID columns to import a copy into another group. Blank cells preserve existing fields. CRM call counts, notes, stages, follow-ups, and verification stamps are not imported; the preview lists ignored columns. Opt-out flags can be set but never cleared by import. Uploading a changed email clears its old verification stamp. All rows commit together or none do; repeat/concurrent uploads are serialized per group to avoid duplicate contacts.

## Deployment and verification

Apply `20260929000000_calling_crm` with the normal Prisma migration deploy process, regenerate Prisma client, and build both apps. Set `APP_PUBLIC_URL` to the real application URL for invitation links. No production database changes were made during development.

The API enforces caller isolation centrally through current database role checks; hiding navigation is not the security boundary. CRM routes independently enforce tenant/group membership. Invitation tokens are random, stored only as SHA-256 hashes, expire after seven days, and are consumed atomically. The token is carried in a URL fragment and stripped from browser history on opening. Call saves serialize per lead and carry a per-user idempotency key to prevent duplicate counts after retries. The UI retries the original activity after uncertain failures and omits unchanged follow-up dates so one caller does not clear another caller’s schedule. Refresh lead loads the latest shared history. Callers are excluded from internal workspace email notifications, including direct subscription attempts.

Tests: `npm run test:crm` runs unit tests and skips the database-dependent cases by default. Integration tests require `CRM_TEST_DB=1` and an explicitly isolated PostgreSQL at `127.0.0.1:55439` via `DATABASE_URL`; they create and clean up test tenants. Never point them at production. `npm run build` in backend and frontend validates both production builds.
