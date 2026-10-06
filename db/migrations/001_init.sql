-- Tables, and the row-level security that lets each signed-in person read only their own submissions.
-- Requires the roles from scripts/setup-local-db.sh: fb_owner runs this; web_user is the role the
-- site uses for signed-in people.

CREATE TABLE forms (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  google_form_id text NOT NULL UNIQUE,
  title text NOT NULL,
  responder_uri text,
  accepting_responses boolean NOT NULL DEFAULT false,
  -- Set from config/forms.json: only emails from forms using "Collect email addresses: Verified" are trusted.
  emails_verified boolean NOT NULL DEFAULT false
);

CREATE TABLE questions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  form_id bigint NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  google_question_id text NOT NULL,
  title text NOT NULL,
  position int NOT NULL,
  removed_at timestamptz,
  UNIQUE (form_id, google_question_id)
);

CREATE TABLE submissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  form_id bigint NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  google_response_id text NOT NULL UNIQUE,
  -- question ID -> answer text, or a list of texts for multi-select questions
  answers jsonb NOT NULL DEFAULT '{}',
  -- the email exactly as Google sent it (verified or typed in)
  respondent_email text,
  -- who may see this submission: the lower-cased email, only if the form's emails are verified
  owner_email text CHECK (owner_email = lower(owner_email)),
  submitted_at timestamptz NOT NULL,
  last_submitted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz NOT NULL DEFAULT now(),
  removed_from_source_at timestamptz,
  -- Removal request: the row stays so sync won't re-import it, but its content must be gone.
  deleted_at timestamptz,
  CONSTRAINT deleted_rows_hold_no_content
    CHECK (deleted_at IS NULL OR (answers = '{}' AND respondent_email IS NULL AND owner_email IS NULL))
);
CREATE INDEX submissions_by_owner ON submissions (owner_email, submitted_at DESC);
CREATE INDEX submissions_by_form ON submissions (form_id, submitted_at DESC);

CREATE TABLE sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  google_form_id text NOT NULL,
  form_id bigint REFERENCES forms (id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok boolean,
  fetched int NOT NULL DEFAULT 0,
  inserted int NOT NULL DEFAULT 0,
  updated int NOT NULL DEFAULT 0,
  removed int NOT NULL DEFAULT 0,
  error text
);
CREATE INDEX sync_runs_recent ON sync_runs (started_at DESC);

-- The signed-in person's email, set by the site per transaction with set_config('app.user_email', $1, true).
-- NULL when not set, so every policy below matches nothing.
CREATE FUNCTION app_user_email() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT lower(nullif(current_setting('app.user_email', true), '')) $$;

ALTER TABLE forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY signed_in_reads_forms ON forms FOR SELECT TO web_user USING (app_user_email() IS NOT NULL);
CREATE POLICY signed_in_reads_questions ON questions FOR SELECT TO web_user USING (app_user_email() IS NOT NULL);
CREATE POLICY own_submissions_only ON submissions FOR SELECT TO web_user USING (
  owner_email IS NOT NULL
  AND owner_email = app_user_email()
  AND deleted_at IS NULL
  AND removed_from_source_at IS NULL
);

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO web_user;
GRANT SELECT (id, title, responder_uri, accepting_responses) ON forms TO web_user;
GRANT SELECT (id, form_id, google_question_id, title, position) ON questions TO web_user;
GRANT SELECT (id, form_id, answers, owner_email, submitted_at, last_submitted_at) ON submissions TO web_user;
