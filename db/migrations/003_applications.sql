-- Forms the signed-in person has responded to, rather than ones they own.
--
-- Google has no way to ask which forms somebody has answered, so these are found by reading the
-- "copy of your response" emails Google sends when a form's owner has switched that on. They are
-- therefore a record of what was found, not a complete list: a form whose owner left that setting
-- off leaves no trace anywhere, and nothing can recover it.
--
-- Only the owner's own inbox is read for now. person_email is here so that reading each visitor's
-- inbox later is a row-level-security policy and a sync change, not a migration and a backfill.

CREATE TABLE applications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Whose application this is: the lower-cased email of the inbox it was found in.
  person_email text NOT NULL CHECK (person_email = lower(person_email)),
  -- The id out of the link. For a /forms/d/e/<id>/viewform link this is Google's *published* id,
  -- which is not the id the Forms API uses and cannot be turned into it. These are other people's
  -- forms, so the API would refuse them anyway; the id is only ever used to tell forms apart.
  form_id text NOT NULL,
  form_id_kind text NOT NULL CHECK (form_id_kind IN ('published', 'direct')),
  -- Where to send the person to see or change their answers.
  link text NOT NULL,
  -- Best effort, from the email. Google does not document these emails, so this can be unhelpful.
  title text NOT NULL,
  -- When they applied: the date on the email, which is when Google sent the copy.
  applied_at timestamptz NOT NULL,
  -- The Gmail message it came from. Re-scanning the same mailbox must not create a second row.
  gmail_message_id text NOT NULL,
  found_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_email, gmail_message_id)
);

CREATE INDEX applications_by_person ON applications (person_email, applied_at DESC);

-- No grant to web_user: for now this is read by the owner area on the owner connection, the same
-- way sync_runs is. Granting it to signed-in people is part of the per-visitor version.
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
