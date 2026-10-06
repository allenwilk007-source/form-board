-- Record which form a sync run was for even when the form isn't in the database yet
-- (its first fetch failed), and how many submissions the run found deleted in Google.
ALTER TABLE sync_runs ADD COLUMN google_form_id text NOT NULL DEFAULT '';
ALTER TABLE sync_runs ADD COLUMN removed int NOT NULL DEFAULT 0;
CREATE INDEX sync_runs_recent ON sync_runs (started_at DESC);
