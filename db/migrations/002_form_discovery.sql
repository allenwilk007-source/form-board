-- Forms are now discovered from the owner's Drive (forms changed in the last 60 days) instead of a
-- config file. A form no longer in that list stays in the database, so people keep their past
-- submissions, but it leaves "Open forms".
ALTER TABLE forms ADD COLUMN listed boolean NOT NULL DEFAULT true;
GRANT SELECT (listed) ON forms TO web_user;
