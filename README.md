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

Every form you own that was created in the last 60 days. A submission shows in its sender's
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
2. Under **Authorized redirect URIs**, add `https://developers.google.com/oauthplayground`. Create it.
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
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. Then run the read-only check:

```bash
npm run google:check   # lists your forms, open or closed, email setting, response count; changes nothing
```

If Google ever stops accepting the approval, sync fails with a message saying so in the owner area's
sync log; repeat step 4 to reconnect.
