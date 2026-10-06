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

## Adding a form

Add its Google form ID to `config/forms.json`. Set `emailsVerified` to `true` only if the form's
*Settings › Responses › Collect email addresses* is **Verified**. Emails from other forms are never
trusted, so their submissions are visible only to you.
