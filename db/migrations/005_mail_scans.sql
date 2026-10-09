-- How far each mailbox has been read, so a scan only fetches mail that arrived since the last one
-- instead of every matching message every time.
--
-- Moved forward only by a scan that read everything it was asked to. A scan cut short by its cap
-- left the *oldest* matches unread (Gmail returns newest first), and moving past them would lose
-- them for good.
CREATE TABLE mail_scans (
  person_email text PRIMARY KEY CHECK (person_email = lower(person_email)),
  -- Every matching message received before this moment has been read.
  read_through timestamptz NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mail_scans ENABLE ROW LEVEL SECURITY;
