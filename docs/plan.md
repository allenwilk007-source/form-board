# form-board plan

Approved by the owner on 2026-10-06 (Phase 0).

## Goal

A website that shows submissions collected through Google Forms: the active ones (status `pending`)
and an archive. New responses arrive automatically. An admin approves what is shown, and private
answers never reach a visitor's browser.

## Build order: private first

Phases 1 to 4 run entirely inside a dev environment against **fake example forms**, shaped exactly
like Google Forms API output, in a local Postgres 16. Nothing is deployed and no real respondent
data is used. Going live (real Google credential, Supabase, Vercel, real-form checks, consent
review) is a separate final phase.

Known weak spot: tests against fake data prove the logic, not that real Google data has the same
shape. The go-live phase must check one real form before anything is published.

## Stack

- Next.js (App Router, TypeScript) for the public site, the admin area and the sync endpoint.
- Postgres via `pg`, with plain SQL migrations in `db/migrations/`. No ORM.
- Vitest for unit and database tests. Playwright for browser tests and screenshots.
- Admin login: one password, stored as a scrypt hash in an environment variable, and a signed
  httpOnly session cookie. No auth library.
- Later hosting: Vercel (site) and Supabase (Postgres). Sync is triggered every 15 minutes by the
  database's scheduler, because Vercel's free plan may limit scheduled jobs to once a day (to be
  checked at go-live).

## Source of truth: the Google Forms API, not the linked Sheet

- Every API response has a stable `responseId`. The Sheet has none, so idempotency would rest on a
  hash that breaks when someone edits a cell.
- API answers are keyed by `questionId`, which survives renaming a question. Sheet columns are
  keyed by header text.
- The Sheet can be edited by anyone with access. The API returns what was submitted.
- Cost: a Google Cloud project, the Forms API enabled, and a credential. Decided at go-live.

Sync fetches all responses of a form on each run and upserts by `responseId`. At the expected
volume (hundreds of responses) this is a few API pages and also detects responses deleted in Google.
Push notifications (Forms "watches") need Pub/Sub and renewing every 7 days; they are left out.

## Privacy by construction

- The public site connects as the database role `web_public`. That role can read only two views:
  `public_forms` and `public_submissions`. It has no access to any table.
- `public_submissions` contains only published, non-deleted submissions, and only the answers to
  questions marked public.
- Which questions are public is set in `config/fields.json`, by question ID. Any question not
  listed there, including one added to the form later, is private.
- Respondent email (if a form collects it) is stored in its own column and is never in a view.
- Row-level security is enabled on every table with no policy for `web_public`, so even a grant
  added by mistake returns no rows.

## Data model

- `forms`: `id`, `google_form_id` (unique), `title`.
- `questions`: `form_id`, `google_question_id`, `title`, `position`, `is_public` (default false),
  `removed_at`. Unique on (`form_id`, `google_question_id`).
- `submissions`:
  - `google_response_id` (unique), `form_id`, `answers` (jsonb: question ID to text or list of
    text), `respondent_email`
  - `status`: `pending` | `resolved` | `rejected`, default `pending`
  - `visibility`: `hidden` | `published`, default `hidden`
  - `submitted_at` (Google `createTime`), `last_submitted_at` (Google `lastSubmittedTime`),
    `created_at`, `status_changed_at`, `synced_at`, `removed_from_source_at`, `deleted_at`
- `sync_runs`: `form_id`, `started_at`, `finished_at`, `ok`, `fetched`, `inserted`, `updated`,
  `error`.

Views: "Active" = published and `pending`. "Archive" = published and `resolved` or `rejected`.

## Decisions taken by default (owner may change)

1. **Takedown:** deleting a submission wipes its answers and email and sets `deleted_at`, but keeps
   the row and its `google_response_id`, so the next sync does not re-import it.
2. **Edited after publishing:** if Google's `lastSubmittedTime` changes, the answers are updated and
   the submission goes back to `hidden` until re-approved.
3. **Deleted in Google Forms:** the submission is hidden and `removed_from_source_at` is set. It is
   not deleted from the site's database.
4. **Statuses:** `pending`, `resolved` (meaning "done") and `rejected`.

## Example forms (fake)

- **Community Project Ideas**:
  - public: title, description, category
  - private: name, email
- **Help Requests**:
  - public: topic, details
  - private: email, phone
  - a question, "Urgency", is added partway through the responses (a schema change)

The responses include HTML and script tags, accents and emoji, blank answers, a response edited
after it was first sent, and a response deleted in Google.

## Phases

Each phase ends at a checkpoint where the owner reviews before the next starts.

1. **Data layer:** migrations, roles, views, the field-visibility config, fake data and seeding.
   Tests for the public-field filter.
2. **Sync:** backfill and incremental sync from the fake Google client, logging to `sync_runs`.
   Tests for idempotency, schema changes, edits, deletions and failure logging.
3. **Admin:** login, approve/hide, status changes, takedown, sync log, manual re-sync. Tests that
   every admin endpoint refuses unauthenticated requests.
4. **Public site:** Active, Archive and submission pages, with search, filters, sort and
   pagination. Screenshots at mobile and desktop widths, and Lighthouse accessibility ≥ 90.
5. **Go-live:** Google credential, Supabase, Vercel, scheduled sync, rate limiting, error pages,
   consent review, a real-form check, and a README.

## Definition of done

Phases 1 to 4 verify these against the fake forms. Phase 5 repeats the starred ones against a real
form.

- [ ] * Response count in the database matches the source for every form.
- [ ] * A new submission appears in admin within one sync, hidden.
- [ ] * Running sync twice creates zero duplicates.
- [ ] * Page source and every public API response contain no private value (grep a known test email).
- [ ] Unauthenticated calls to every admin endpoint return 401 or 403.
- [ ] Changing status moves a submission between Active and Archive.
- [ ] Unpublishing removes it from all public pages and API responses.
- [ ] * Adding a question to the form does not break sync, and the new question is private.
- [ ] Lighthouse accessibility ≥ 90 on public pages.
- [ ] All tests pass, and the README instructions work from a clean clone.
