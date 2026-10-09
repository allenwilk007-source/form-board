// Turning the owner's mail into a list of forms they were sent or have answered.
import type { Queryable } from './db.ts';
import { EDIT_RESPONSE, formLinks, keep, resolveShortLinks, type FormLink } from './form-links.ts';
import { FORM_MAIL_QUERY, receivedAfter, type Mailbox, type MailMessage } from './gmail.ts';

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
 * The forms one message is about. A message mentioning two forms yields two.
 *
 * `resolved` maps forms.gle short codes to the forms they lead to. A short link that was followed
 * becomes that form, so an invitation sent as forms.gle/abc and a receipt carrying the full link
 * are recognised as the same form. A short link that could not be followed stays as itself.
 */
export function applicationsIn(message: MailMessage, resolved: ReadonlyMap<string, FormLink> = new Map()): Application[] {
  // Swap followed short links for their forms, then de-duplicate again: a receipt can carry the
  // same form both as a short link and as its full edit-your-response link.
  const seen = new Map<string, FormLink>();
  for (const link of formLinks(message.text)) keep(seen, (link.kind === 'short' && resolved.get(link.id)) || link);
  const links = [...seen.values()];

  return links.map((link) => ({
    formId: link.id,
    formIdKind: link.kind,
    link: link.url,
    title: message.subject.trim() || '(no subject)',
    appliedAt: message.receivedAt,
    gmailMessageId: message.id,
    // Google's "edit your response" link can only exist once a response has been sent, and it is
    // that one form's own response address, so it proves *that* form was sent — and, being part of
    // the link, it survives Google rewording the mail and works in every language. Any other form
    // in the same mail (a footer, a "see also", a short share link) is only known to have arrived.
    status: EDIT_RESPONSE.test(link.url) ? 'submitted' : 'found',
  }));
}

/**
 * Mail about the same moment can be dated slightly differently by Gmail's search and by the
 * message itself. Re-reading a day of overlap costs a few messages; missing one costs an
 * application. Re-reading is harmless because rows are keyed on the message.
 */
export const RESCAN_OVERLAP_MS = 864e5;

export type Scan = {
  found: Application[];
  messages: number;
  complete: boolean;
  /** forms.gle links seen, and how many of them could not be followed to a form. */
  shortLinks: number;
  unresolved: number;
};

/**
 * Everything the mailbox can say about forms. With `since`, only mail received after it (less the
 * overlap) is fetched. Reads only; stores nothing.
 */
export async function scanMailbox(
  mailbox: Mailbox,
  {
    query = FORM_MAIL_QUERY,
    max = 500,
    since,
    fetch: doFetch = fetch,
  }: { query?: string; max?: number; since?: Date | null; fetch?: typeof fetch } = {},
): Promise<Scan> {
  const q = since ? receivedAfter(query, new Date(since.getTime() - RESCAN_OVERLAP_MS)) : query;
  const { messages, complete } = await mailbox.search(q, max);
  const codes = new Set(messages.flatMap((m) => formLinks(m.text).filter((l) => l.kind === 'short').map((l) => l.id)));
  const resolved = await resolveShortLinks(codes, doFetch);
  return {
    found: messages.flatMap((m) => applicationsIn(m, resolved)),
    messages: messages.length,
    complete,
    shortLinks: codes.size,
    unresolved: codes.size - resolved.size,
  };
}

/** Up to when this mailbox has been fully read, or null if it never has. */
export async function readThrough(db: Queryable, personEmail: string): Promise<Date | null> {
  return (await db.query<{ read_through: Date }>('SELECT read_through FROM mail_scans WHERE person_email = $1', [personEmail.toLowerCase()])).rows[0]?.read_through ?? null;
}

/**
 * Records that every matching message before `through` has been read. Never moves backwards, so
 * a slow scan finishing after a quicker later one cannot undo it.
 */
export async function markReadThrough(db: Queryable, personEmail: string, through: Date): Promise<void> {
  await db.query(
    `INSERT INTO mail_scans (person_email, read_through) VALUES ($1, $2)
     ON CONFLICT (person_email) DO UPDATE SET read_through = GREATEST(mail_scans.read_through, EXCLUDED.read_through), scanned_at = now()`,
    [personEmail.toLowerCase(), through],
  );
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
