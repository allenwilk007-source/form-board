import type { Queryable } from './db.ts';

// Everything the owner area reads and changes. Called only after isOwner() has passed, on the owner pool.

export const PAGE_SIZE = 25;

export type OwnerForm = { id: string; google_form_id: string; title: string; accepting_responses: boolean; emails_verified: boolean; submissions: number };
export type OwnerSubmissionRow = {
  id: string;
  form_id: string;
  form_title: string;
  google_response_id: string;
  owner_email: string | null;
  respondent_email: string | null;
  submitted_at: Date;
  removed_from_source_at: Date | null;
  deleted_at: Date | null;
};

export async function listForms(db: Queryable): Promise<OwnerForm[]> {
  return (
    await db.query<OwnerForm>(
      `SELECT f.id, f.google_form_id, f.title, f.accepting_responses, f.emails_verified,
              (SELECT count(*)::int FROM submissions s WHERE s.form_id = f.id) AS submissions
       FROM forms f ORDER BY f.title`,
    )
  ).rows;
}

/** Newest first. `q` matches answers, emails, the form title and the response ID, ignoring case. */
export async function listSubmissions(
  db: Queryable,
  opts: { q?: string; formId?: string; page?: number },
): Promise<{ rows: OwnerSubmissionRow[]; total: number; page: number; pages: number }> {
  const q = opts.q?.trim() ? `%${opts.q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;
  const formId = opts.formId && /^\d+$/.test(opts.formId) ? opts.formId : null;
  const where = `($1::text IS NULL OR s.answers::text ILIKE $1 OR s.owner_email ILIKE $1 OR s.respondent_email ILIKE $1
                   OR f.title ILIKE $1 OR s.google_response_id ILIKE $1)
                 AND ($2::bigint IS NULL OR s.form_id = $2)`;
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM submissions s JOIN forms f ON f.id = s.form_id WHERE ${where}`, [q, formId])).rows[0].n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(opts.page ?? 1) || 1), pages);
  const rows = (
    await db.query<OwnerSubmissionRow>(
      `SELECT s.id, s.form_id, f.title AS form_title, s.google_response_id, s.owner_email, s.respondent_email,
              s.submitted_at, s.removed_from_source_at, s.deleted_at
       FROM submissions s JOIN forms f ON f.id = s.form_id
       WHERE ${where}
       ORDER BY s.submitted_at DESC, s.id DESC
       LIMIT ${PAGE_SIZE} OFFSET $3`,
      [q, formId, (page - 1) * PAGE_SIZE],
    )
  ).rows;
  return { rows, total, page, pages };
}

export type OwnerSubmission = OwnerSubmissionRow & {
  answers: Record<string, string | string[]>;
  last_submitted_at: Date;
  questions: { id: string; title: string; removed: boolean }[];
};

export async function getSubmission(db: Queryable, id: string): Promise<OwnerSubmission | null> {
  if (!/^\d+$/.test(id)) return null;
  const s = (
    await db.query(
      `SELECT s.id, s.form_id, f.title AS form_title, s.google_response_id, s.owner_email, s.respondent_email, s.answers,
              s.submitted_at, s.last_submitted_at, s.removed_from_source_at, s.deleted_at
       FROM submissions s JOIN forms f ON f.id = s.form_id WHERE s.id = $1`,
      [id],
    )
  ).rows[0];
  if (!s) return null;
  const questions = (
    await db.query(
      'SELECT google_question_id AS id, title, removed_at IS NOT NULL AS removed FROM questions WHERE form_id = $1 ORDER BY position',
      [s.form_id],
    )
  ).rows;
  return { ...s, questions };
}

/** Removal request: wipes the content but keeps the row, so sync never re-imports it. Returns false if already deleted or missing. */
export async function deleteSubmission(db: Queryable, id: string): Promise<boolean> {
  if (!/^\d+$/.test(id)) return false;
  const r = await db.query(
    `UPDATE submissions SET deleted_at = now(), answers = '{}', respondent_email = NULL, owner_email = NULL
     WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return r.rowCount === 1;
}

export type SyncRun = { id: string; google_form_id: string; form_title: string | null; started_at: Date; finished_at: Date | null; ok: boolean | null; fetched: number; inserted: number; updated: number; removed: number; error: string | null };

export async function recentSyncRuns(db: Queryable, limit = 20): Promise<SyncRun[]> {
  return (
    await db.query<SyncRun>(
      `SELECT r.id, r.google_form_id, f.title AS form_title, r.started_at, r.finished_at, r.ok, r.fetched, r.inserted, r.updated, r.removed, r.error
       FROM sync_runs r LEFT JOIN forms f ON f.google_form_id = r.google_form_id
       ORDER BY r.id DESC LIMIT $1`,
      [limit],
    )
  ).rows;
}
