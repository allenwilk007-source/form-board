import type pg from 'pg';
import { asUser } from './as-user.ts';

// What a signed-in person sees. Every query runs through asUser on the web_user pool, so row-level
// security, not this code, decides which submissions come back.

export type OpenForm = { id: string; title: string; responder_uri: string | null };
export type MySubmissionRow = { id: string; form_id: string; form_title: string; form_open: boolean; submitted_at: Date; last_submitted_at: Date };
export type MySubmission = MySubmissionRow & { answers: Record<string, string | string[]>; questions: { id: string; title: string }[] };

export async function homeFor(pool: pg.Pool, email: string): Promise<{ openForms: OpenForm[]; submissions: MySubmissionRow[] }> {
  return asUser(pool, email, async (db) => {
    const submissions = (
      await db.query<MySubmissionRow>(
        `SELECT s.id, s.form_id, f.title AS form_title, f.accepting_responses AS form_open, s.submitted_at, s.last_submitted_at
         FROM submissions s JOIN forms f ON f.id = s.form_id
         ORDER BY s.submitted_at DESC, s.id DESC`,
      )
    ).rows;
    // Open forms the person hasn't sent yet. A form they've sent moves to "My submissions".
    const openForms = (
      await db.query<OpenForm>(
        `SELECT f.id, f.title, f.responder_uri FROM forms f
         WHERE f.accepting_responses AND f.listed AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.form_id = f.id)
         ORDER BY f.title`,
      )
    ).rows;
    return { openForms, submissions };
  });
}

/** One of the person's own submissions, or null: someone else's looks exactly like one that doesn't exist. */
export async function mySubmission(pool: pg.Pool, email: string, id: string): Promise<MySubmission | null> {
  if (!/^\d+$/.test(id)) return null;
  return asUser(pool, email, async (db) => {
    const s = (
      await db.query(
        `SELECT s.id, s.form_id, f.title AS form_title, f.accepting_responses AS form_open, s.submitted_at, s.last_submitted_at, s.answers
         FROM submissions s JOIN forms f ON f.id = s.form_id WHERE s.id = $1`,
        [id],
      )
    ).rows[0];
    if (!s) return null;
    const questions = (await db.query('SELECT google_question_id AS id, title FROM questions WHERE form_id = $1 ORDER BY position', [s.form_id])).rows;
    return { ...s, questions };
  });
}
