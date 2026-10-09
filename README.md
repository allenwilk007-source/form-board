# form-board

A website where each person signs in with Google and sees your open Google Forms, plus the forms
they have sent, with their answers read-only. Nobody sees anyone else's submissions. See
`docs/plan.md` for the design. This is the private build: it runs locally against fake forms.

## Local setup

Needs Node 22.18+ and PostgreSQL 16.

```bash
npm install
cp .env.example .env
npm run db:setup     # creates the local roles and database (needs Postgres superuser rights)
npm run db:migrate
npm run db:seed      # replaces all data with the four fake forms, via a normal sync
npm run sync         # imports new and changed responses (from the fake forms, for now)
npm test             # recreates a separate test database each run
```

## Which forms appear

Every form you own that is **still accepting responses**, however long ago you last touched it, plus
any form **changed in the last 60 days** (Google Drive's "last modified" date) even if it has closed.
So an open form never disappears, a newly made one appears at the next sync, and a closed one stays
listed for 60 days afterwards and then drops off "Open forms".

Dropping off the list never hides anybody's answers: people keep seeing their own submissions to a
form that is no longer listed. A submission shows in its sender's
"My submissions" only if the form's *Settings › Responses › Collect email addresses* is **Verified**;
the site reads that setting from Google. Typed-in emails are never trusted.

## Connect Google (read-only)

Sync reads your forms with a one-time, read-only approval from your Google account. About 15 minutes,
all in the browser, signed in to Google as the owner.

**1. Create a Google Cloud project**
1. Open https://console.cloud.google.com. In the project picker at the top, choose **New project**,
   name it `form-board`, and create it.
2. Go to **APIs & Services › Library** and enable **Google Forms API** and **Google Drive API**.

**2. Set up the approval screen**
1. Go to **Google Auth Platform** (also shown as **OAuth consent screen**). Choose **External**, app
   name `form-board`, and your Gmail as the support and developer email.
2. Under **Data access**, add these scopes:
   - `https://www.googleapis.com/auth/drive.metadata.readonly` (names and dates of your files, not their contents)
   - `https://www.googleapis.com/auth/forms.body.readonly`
   - `https://www.googleapis.com/auth/forms.responses.readonly`
3. Under **Audience**, click **Publish app** so the status is **In production**. In "Testing", Google
   makes the approval expire after 7 days and sync stops.

**3. Create the client**
1. Go to **Clients** (or **Credentials**) › **Create client** › **Web application**, name `form-board`.
2. Under **Authorized redirect URIs**, add both of these, then create it:
   - `https://developers.google.com/oauthplayground` — for step 4 below, to get your refresh token.
   - `http://localhost:3000/api/auth/google/callback` — where people land after signing in. Add your
     real address (`https://your-site/api/auth/google/callback`) too once you have one; Google matches
     these character for character, so a trailing slash or `http` for `https` will be rejected.
3. Keep the **Client ID** and **Client secret** private, like a password.

**4. Approve, and get the refresh token**
1. Open https://developers.google.com/oauthplayground. Click the gear icon, tick **Use your own OAuth
   credentials**, and paste the Client ID and secret.
2. In **Input your own scopes**, paste the three scope addresses above, separated by spaces, and click
   **Authorize APIs**. Sign in as the owner. Google warns the app isn't verified: click **Advanced ›
   Go to form-board**, then allow.
3. Click **Exchange authorization code for tokens** and copy the **Refresh token**.

**5. Hand it to the site.** Never paste these into a chat or commit them. In the build environment's
settings (or Vercel's), add environment variables: `FORMS_SOURCE=google`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_REDIRECT_URI`. Then run the read-only check:

```bash
npm run google:check   # lists your forms, open or closed, email setting, response count; changes nothing
```

If Google ever stops accepting the approval, sync fails with a message saying so in the owner area's
sync log; repeat step 4 to reconnect.

## Forms you applied to

The other half of the site: forms somebody *else* made, that you were sent or have answered.

Google has no way to ask which forms a person has responded to. The Forms API only answers for
forms you own, and Google Forms keeps no such list. The one trace is your mail, so that is what is
read — for the **link** a message carries, never its wording, so it works in any language and
survives Google rewording its own emails.

```bash
npm run gmail:check   # lists what your mail says; stores nothing
npm run gmail:scan    # the same, and stores it
```

The first `gmail:scan` reads every matching message (up to 500; `npm run gmail:scan -- 2000` reads
more). After that it remembers how far it got and only fetches mail that arrived since, with a day
of overlap, so a routine run is a handful of requests. If a scan hits its cap before reaching the
oldest matching mail it says so and does not move on, so nothing is skipped: run it once with a
bigger number. `npm run gmail:scan -- --full` reads everything again.

Each form comes back as one of:

- **found** — a form reached you. Whether you answered it is not known.
- **submitted** — you answered it, proved by a link back to your own response ("edit your response"),
  which only exists once a response has been sent.

There is deliberately no "opened". Nothing in a mailbox can say whether you opened a form, and a
receipt only exists after you have answered. Catching that needs a browser extension, not mail.

**What this cannot find:** a form nobody emailed you, and a form you answered whose owner left
*"Send responders a copy of their response"* switched off — that leaves no trace anywhere, and no
amount of scanning recovers it. Run `npm run gmail:check` before relying on this: if it finds
nothing, this approach cannot work for you.

**To switch it on**, redo the approval in "Connect Google" above, adding a fourth scope:

- `https://www.googleapis.com/auth/gmail.readonly`

Google counts that a **restricted** scope. An unverified app is capped at 100 users for life, and
going beyond that needs Google verification plus an annual third-party security assessment. For one
mailbox — yours — the cap is not a problem, but know that it exists before building on it.

## Sign in with Google

Visitors sign in with their Google account. The site asks them for `openid email` and nothing else:
it learns the address Google has verified for them, and never gets access to their Drive or their
forms. That is a separate thing from your own approval above, which is what lets sync read *your*
forms — the two share a Google client but not a single scope.

Sign-in appears once `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` are all
set; until then the sign-in page says so. To try it locally, `npm run dev` and open
http://localhost:3000 — the address must be exactly `localhost:3000`, because that is what is
registered with Google.

A submission is still only matched to the person who sent it when the form collects **Verified**
emails (see "Which forms appear"). Signing in does not change that: an address Google verified at
sign-in says who the visitor is, not who filled in a form that never asked.
