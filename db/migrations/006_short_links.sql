-- Forms reached by a forms.gle short link. When the link can be followed it is stored as the form
-- it leads to, like any other; when it cannot (forms.gle unreachable, the link dead), it is still
-- recorded by its short code rather than dropped, so the application is not lost.
ALTER TABLE applications DROP CONSTRAINT applications_form_id_kind_check;
ALTER TABLE applications ADD CONSTRAINT applications_form_id_kind_check
  CHECK (form_id_kind IN ('published', 'direct', 'short'));
