// Turning the owner's mail into a list of forms they were sent or have answered.
import type { Queryable } from './db.ts';
import { formLinks, type FormLink } from './form-links.ts';
import { FORM_MAIL_QUERY, type Mailbox, type MailMessage } from './gmail.ts';

/**
 * How far a form has got.
 * - `found`: a form reached them. Whether they answered it is not known.
 * - `submitted`: they answered it, because the mail carries a link back to their own response.
 *
 * There is no `opened`: nothing in a mailbox can say whether somebody opened a form, and a receipt
 * only exists once it has been answered. Catching the opening needs the browser, not the mail.
 */
export type Status = 'found' | 'submitted';

export type Application = {
  formId: string;
  formIdKind: FormLink['kind'];
  link: string;
  title: string;
  appliedAt: Date;
  gmailMessageId: string;
  status: Status;
};

/**
 * Google's "edit your response" link carries this. It can only exist once a response has been
 * sent, so it is proof of a submission — and, being part of the link, it survives Google rewording
 * the mail and works in every language, which reading the text would not.
 */
const EDIT_RESPONSE = /[?&]edit2=/;

/** The forms one message is about. A message mentioning two forms yields two. */
export function applicationsIn(message: MailMessage): Application[] {
  const links = formLinks(message.text);
  const submitted = links.some((l) => EDIT_RESPONSE.test(l.url));
  return links.map((link) => ({
    formId: link.id,
    formIdKind: link.kind,
    link: link.url,
    title: message.subject.trim() || '(no subject)',
    appliedAt: message.receivedAt,
    gmailMessageId: message.id,
    // One message, one verdict: a receipt names the form it is a receipt for, and a link to a
    // second form in the same mail (a footer, a "see also") is not evidence about that one.
    status: submitted && links.length === 1 ? 'submitted' : 'found',
  }));
}

/** Everything the mailbox can say about forms, newest mail first. Reads only; stores nothing. */
export async function scanMailbox(mailbox: Mailbox, { query = FORM_MAIL_QUERY, max = 500 } = {}): Promise<Application[]> {
  const messages = await mailbox.search(query, max);
  return messages.flatMap(applicationsIn);
}

/**
 * Stores what a scan found. Running it twice changes nothing: rows are keyed on the Gmail message,
 * so the same mail never lands twice. A form already marked submitted is never walked back to
 * found, since a later invitation mail says nothing about an answer already sent.
 */
export async function saveApplications(db: Queryable, personEmail: string, found: Application[]): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  for (const a of found) {
    const { rows } = await db.query<{ inserted: boolean }>(
      `INSERT INTO applications (person_email, form_id, form_id_kind, link, title, applied_at, gmail_message_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (person_email, gmail_message_id) DO UPDATE SET
         link = EXCLUDED.link, title = EXCLUDED.title, applied_at = EXCLUDED.applied_at,
         status = CASE WHEN applications.status = 'submitted' THEN 'submitted' ELSE EXCLUDED.status END
       WHERE applications.link IS DISTINCT FROM EXCLUDED.link OR applications.title IS DISTINCT FROM EXCLUDED.title
          OR (applications.status <> 'submitted' AND applications.status IS DISTINCT FROM EXCLUDED.status)
       RETURNING (xmax = 0) AS inserted`,
      [personEmail.toLowerCase(), a.formId, a.formIdKind, a.link, a.title, a.appliedAt, a.gmailMessageId, a.status],
    );
    if (rows[0]?.inserted) added++;
    else if (rows[0]) updated++;
  }
  return { added, updated };
}

export type ApplicationRow = {
  id: string;
  form_id: string;
  link: string;
  title: string;
  applied_at: Date;
  status: Status;
};

/** One person's applications, newest first. The same form seen in several mails appears once. */
export async function listApplications(db: Queryable, personEmail: string): Promise<ApplicationRow[]> {
  return (
    await db.query<ApplicationRow>(
      `SELECT DISTINCT ON (form_id) id, form_id, link, title, applied_at, status
       FROM applications WHERE person_email = $1
       -- Of several mails about one form, keep the one that proves the most, then the newest.
       ORDER BY form_id, (status = 'submitted') DESC, applied_at DESC
      `,
      [personEmail.toLowerCase()],
    )
  ).rows.sort((a, b) => b.applied_at.getTime() - a.applied_at.getTime());
}
