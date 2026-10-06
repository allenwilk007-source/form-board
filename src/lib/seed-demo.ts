import type pg from 'pg';
import { fakeForms, fakeResponses } from '../fake-google/data.ts';
import { applyFieldConfig, type FieldConfig } from './fields.ts';
import { formQuestions, normalizeResponse } from './google.ts';

/**
 * Replaces all data with the fake forms, in a demo state: most submissions published, with a mix of
 * statuses, so the site has something to show. Real data only ever arrives through sync, where new
 * submissions start hidden.
 */
export async function seedDemo(client: pg.Client, config: FieldConfig): Promise<{ forms: number; submissions: number }> {
  let submissions = 0;
  await client.query('BEGIN');
  try {
    await client.query('TRUNCATE forms, questions, submissions, sync_runs RESTART IDENTITY CASCADE');
    for (const form of fakeForms) {
      const { rows } = await client.query<{ id: string }>('INSERT INTO forms (google_form_id, title) VALUES ($1, $2) RETURNING id', [form.formId, form.info.title]);
      const formId = rows[0].id;
      for (const q of formQuestions(form)) {
        await client.query('INSERT INTO questions (form_id, google_question_id, title, position) VALUES ($1, $2, $3, $4)', [formId, q.googleQuestionId, q.title, q.position]);
      }
      for (const [i, raw] of fakeResponses[form.formId].entries()) {
        const r = normalizeResponse(raw);
        const visibility = i % 4 === 3 ? 'hidden' : 'published';
        const status = i % 7 === 0 ? 'rejected' : i % 5 === 0 ? 'resolved' : 'pending';
        await client.query(
          `INSERT INTO submissions (form_id, google_response_id, answers, respondent_email, submitted_at, last_submitted_at, visibility, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [formId, r.googleResponseId, r.answers, r.respondentEmail, r.submittedAt, r.lastSubmittedAt, visibility, status],
        );
        submissions++;
      }
    }
    await applyFieldConfig(client, config);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  return { forms: fakeForms.length, submissions };
}
