-- Tables, the two public views, and the permissions that keep private answers private.
-- Requires the roles from scripts/setup-local-db.sh: fb_owner runs this, web_public is the site's
-- read-only public role.

CREATE TYPE submission_status AS ENUM ('pending', 'resolved', 'rejected');
CREATE TYPE submission_visibility AS ENUM ('hidden', 'published');

CREATE TABLE forms (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  google_form_id text NOT NULL UNIQUE,
  title text NOT NULL
);

CREATE TABLE questions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  form_id bigint NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  google_question_id text NOT NULL,
  title text NOT NULL,
  position int NOT NULL,
  is_public boolean NOT NULL DEFAULT false,
  removed_at timestamptz,
  UNIQUE (form_id, google_question_id)
);

CREATE TABLE submissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  form_id bigint NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  google_response_id text NOT NULL UNIQUE,
  -- question ID -> answer text, or a list of texts for multi-select questions
  answers jsonb NOT NULL DEFAULT '{}',
  respondent_email text,
  status submission_status NOT NULL DEFAULT 'pending',
  visibility submission_visibility NOT NULL DEFAULT 'hidden',
  submitted_at timestamptz NOT NULL,
  last_submitted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz NOT NULL DEFAULT now(),
  removed_from_source_at timestamptz,
  -- Takedown: the row stays so sync won't re-import it, but its content must be gone.
  deleted_at timestamptz,
  CONSTRAINT deleted_rows_hold_no_content
    CHECK (deleted_at IS NULL OR (answers = '{}' AND respondent_email IS NULL AND visibility = 'hidden'))
);
CREATE INDEX submissions_listing ON submissions (form_id, visibility, status, submitted_at DESC);

CREATE TABLE sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  form_id bigint REFERENCES forms (id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok boolean,
  fetched int NOT NULL DEFAULT 0,
  inserted int NOT NULL DEFAULT 0,
  updated int NOT NULL DEFAULT 0,
  error text
);

-- Public views. They run with the owner's rights, so web_public needs no access to the tables.
CREATE VIEW public_forms WITH (security_barrier) AS
SELECT
  f.id,
  f.title,
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('id', q.google_question_id, 'title', q.title) ORDER BY q.position)
     FROM questions q
     WHERE q.form_id = f.id AND q.is_public),
    '[]'
  ) AS questions
FROM forms f;

CREATE VIEW public_submissions WITH (security_barrier) AS
SELECT
  s.id,
  s.form_id,
  s.status,
  s.submitted_at,
  s.status_changed_at,
  COALESCE(
    (SELECT jsonb_object_agg(q.google_question_id, s.answers -> q.google_question_id)
     FROM questions q
     WHERE q.form_id = s.form_id AND q.is_public AND s.answers ? q.google_question_id),
    '{}'
  ) AS answers
FROM submissions s
WHERE s.visibility = 'published'
  AND s.deleted_at IS NULL
  AND s.removed_from_source_at IS NULL;

-- Defense in depth: RLS on with no policy for web_public means zero rows, even if a table grant
-- were added by mistake. The owner (fb_owner) is not subject to RLS on its own tables.
ALTER TABLE forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO web_public;
GRANT SELECT ON public_forms, public_submissions TO web_public;
