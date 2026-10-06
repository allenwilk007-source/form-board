# form-board plan

Phase 0 approved by the owner on 2026-10-06. Revised the same day (per-person design, approved).

## Goal

A website where each person signs in with Google and sees:

- **Open forms:** the owner's Google Forms that are still accepting responses, each with a link to
  fill it in. Forms the person has already sent move to their other list.
- **My submissions:** the forms they have sent. Opening one shows all their answers, read-only.

Nobody sees anyone else's submissions. The owner sees every form and every submission, the sync
log, a "Sync now" button, and can delete a submission on request. New responses arrive
automatically, without manual exports.

## Build order: private first

Phases run inside a dev environment against **fake forms**, shaped exactly like Google Forms API
output, in a local Postgres 16. Sign-in uses a test-person switch that refuses to run in production.
Going live (real Google sign-in, real forms, Supabase, Vercel) is the final phase.

Known weak spot: tests against fake data prove the logic, not that real Google data has the same
shape. Go-live must check one real form before real people use the site.

## Who a submission belongs to

A submission belongs to the person whose email Google **verified** on it. That needs the form's
setting *Settings › Responses › Collect email addresses* to be **Verified**.

- Google's data may not say whether an email was verified or typed in, so `config/forms.json` marks
  each form's setting. Emails from forms not marked `emailsVerified` are never trusted: otherwise
  anyone could type someone else's email and appear in their account.
- Emails are compared in lower case.
- A submission with no trusted email belongs to no one and is visible only to the owner.
- Responses sent before a form switched to Verified have no email and stay owner-only.

## Stack

- Next.js (App Router, TypeScript) for the site, the owner area and the sync endpoint.
- Postgres via `pg`, with plain SQL migrations in `db/migrations/`. No ORM.
- Vitest for unit and database tests. Playwright for browser tests and screenshots.
- Sign-in: Google sign-in at go-live; in development, a test-person switch.
- Later hosting: Vercel (site) and Supabase (Postgres), with sync every 15 minutes.

## Source of truth: the Google Forms API

- Stable `responseId` per response, so sync never duplicates.
- Answers keyed by `questionId`, which survives renaming.
- The form's `responderUri` gives the "Fill in" link, and its publish settings say whether it is
  accepting responses. A form with no publish settings is treated as open (to confirm at go-live).
- Sync fetches every response of each form on each run and upserts by `responseId`.

## Privacy by construction

- The site reads people's data through the database role `web_user`. Before each request's queries
  the site sets, inside a transaction, which email is signed in (`app.user_email`).
- Row-level security on `submissions` returns only rows whose trusted owner email equals that
  email, and that are not deleted or removed in Google. No email set means zero rows, never all rows.
- `web_user` can read only specific columns of `forms`, `questions` and `submissions`, cannot read
  `sync_runs` or the raw respondent email, and cannot write anything.
- Known trust boundary: the site's server decides which email to set. A bug there could show the
  wrong person's data; the database cannot detect that. Sign-in code gets its own tests in Phase 3.

## Data model

- `forms`: `google_form_id`, `title`, `responder_uri`, `accepting_responses`, `emails_verified`.
- `questions`: `form_id`, `google_question_id`, `title`, `position`, `removed_at`.
- `submissions`: `google_response_id` (unique), `form_id`, `answers` (jsonb: question ID to text or
  list of text), `respondent_email` (as Google sent it), `owner_email` (trusted, lower case, or
  null), `submitted_at`, `last_submitted_at`, `created_at`, `synced_at`, `removed_from_source_at`,
  `deleted_at`.
- `sync_runs`: `google_form_id`, `form_id`, `started_at`, `finished_at`, `ok`, `fetched`,
  `inserted`, `updated`, `removed`, `error`.

## Decisions

1. **Delete (removal request):** wipes the answers and emails and sets `deleted_at`, keeping the
   row and its response ID so sync never re-imports it.
2. **Edited in Google:** the new answers replace the old on the next sync.
3. **Deleted in Google:** hidden from its owner and marked `removed_from_source_at`; cleared if it
   reappears.
4. **Empty answer from Google:** if Google returns no responses for a form that has some stored,
   the run fails and is logged instead of removing everything.
5. **Questions:** new ones are stored as they appear; renames are followed by ID; removed ones are
   marked, and old answers to them are kept.

## Example forms (fake)

- **Community Project Ideas:** open, Verified. Includes HTML/script text, accents and emoji, a blank
  answer, an edited response, a response with no email, and an email in mixed case.
- **Volunteer Sign-up:** open, Verified.
- **Event Feedback:** open, **Responder input** (typed emails, not trusted). Includes a response
  where someone typed another person's email.
- **Help Requests:** closed, Verified. A question, "Urgency", is added partway through.

## Phases

1. Data layer and 2. Sync: done in the first build, then reworked for the per-person design (2b).
3. **Sign-in and owner area:** test-person sign-in that refuses to run in production; owner list
   from an environment variable; owner pages for all submissions (search, form filter, pages), the
   sync log, "Sync now" and Delete. Tests that signed-out and non-owner requests are refused.
4. **Pages:** sign-in, Open forms, My submissions, a submission page. Screenshots at phone and
   desktop widths; Lighthouse accessibility ≥ 90.
5. **Go-live:** Google sign-in, real forms set to Verified, Supabase, Vercel, scheduled sync, rate
   limiting, error pages, a real-form check, and the README.

## Definition of done

Verified on fake forms first; starred items again on a real form at go-live.

- [ ] * Response count in the database matches the source for every form.
- [ ] * A new response appears in its sender's "My submissions" within one sync.
- [ ] * Running sync twice creates zero duplicates.
- [ ] A signed-in person never sees another person's submission (two test people, plus a guessed link).
- [ ] A typed (unverified) email never puts a submission in someone's account.
- [ ] Signed-out requests see no forms and no submissions.
- [ ] Non-owner requests to every owner page and action are refused (401 or 403).
- [ ] A closed form leaves "Open forms"; a sent form moves to "My submissions".
- [ ] Deleting a submission removes it for its owner, and sync never brings it back.
- [ ] * Adding a question to a form doesn't break sync.
- [ ] Lighthouse accessibility ≥ 90 on every page.
- [ ] All tests pass, and the README instructions work from a clean clone.
