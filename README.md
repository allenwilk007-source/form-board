# form-board

A website that shows submissions from Google Forms, with an admin who approves what is public.
See `docs/plan.md` for the design. This is the private build: it runs locally against fake forms.

## Local setup

Needs Node 22.18+ and PostgreSQL 16.

```bash
npm install
cp .env.example .env
npm run db:setup     # creates the local roles and database (needs Postgres superuser rights)
npm run db:migrate
npm run db:seed      # loads the two fake example forms
npm test             # recreates a separate test database each run
```

## Which answers are public

`config/fields.json` lists the public questions of each form by Google question ID. Everything else
is private, including questions added to a form later.
