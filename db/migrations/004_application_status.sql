-- How far an application has got.
--   found     - a form reached this person; whether they answered it is not known.
--   submitted - they answered it, proved by a link back to their own response in the mail.
-- There is deliberately no "opened": a mailbox cannot say whether somebody opened a form, and a
-- receipt only exists once one has been answered. Catching that needs the browser, not the mail.
ALTER TABLE applications ADD COLUMN status text NOT NULL DEFAULT 'found'
  CHECK (status IN ('found', 'submitted'));
