import type pg from 'pg';
import { applyFieldConfig, type FieldConfig } from './fields.ts';
import { formQuestions, normalizeResponse, type GoogleForm, type GoogleResponse } from './google.ts';

/** Where forms and responses come from: the Google Forms API in production, a fake in development and tests. */
export type FormsSource = {
  getForm(googleFormId: string): Promise<GoogleForm>;
  /** Every response to the form (the real client follows all pages). */
  listResponses(googleFormId: string): Promise<GoogleResponse[]>;
};

export type SyncResult = {
  googleFormId: string;
  ok: boolean;
  fetched: number;
  inserted: number;
  updated: number;
  removed: number;
  error?: string;
};

/** Syncs every form listed in the config. One form failing does not stop the others. */
export async function syncAll(pool: pg.Pool, source: FormsSource, config: FieldConfig): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const googleFormId of Object.keys(config.forms)) results.push(await syncForm(pool, source, googleFormId, config));
  return results;
}

/**
 * Brings one form's questions and responses up to date. Safe to run any number of times, and
 * concurrently: responses are matched on Google's response ID, and runs for the same form take turns.
 * - New responses arrive hidden and pending.
 * - A response edited in Google gets the new answers and goes back to hidden.
 * - A response deleted in Google is hidden and marked removed; one taken down here is never re-imported.
 * - New questions are private unless the config lists them.
 * Every run is logged in sync_runs, including failures, which roll back all of that run's changes.
 */
export async function syncForm(pool: pg.Pool, source: FormsSource, googleFormId: string, config: FieldConfig): Promise<SyncResult> {
  const result: SyncResult = { googleFormId, ok: false, fetched: 0, inserted: 0, updated: 0, removed: 0 };
  const { rows } = await pool.query<{ id: string }>('INSERT INTO sync_runs (google_form_id) VALUES ($1) RETURNING id', [googleFormId]);
  const runId = rows[0].id;

  const client = await pool.connect();
  let formId: string | null = null;
  try {
    const form = await source.getForm(googleFormId);
    const responses = (await source.listResponses(googleFormId)).map(checkedResponse).map(normalizeResponse);
    result.fetched = responses.length;

    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [googleFormId]);

    formId = (
      await client.query<{ id: string }>(
        `INSERT INTO forms (google_form_id, title) VALUES ($1, $2)
         ON CONFLICT (google_form_id) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
        [googleFormId, form.info.title],
      )
    ).rows[0].id;

    const stored = (
      await client.query<{ n: number }>('SELECT count(*)::int AS n FROM submissions WHERE form_id = $1 AND deleted_at IS NULL AND removed_from_source_at IS NULL', [formId])
    ).rows[0].n;
    if (responses.length === 0 && stored > 0) {
      throw new Error(`Google returned no responses but ${stored} are stored; refusing to mark them all deleted. Check the form, then re-sync.`);
    }

    const questions = formQuestions(form);
    for (const q of questions) {
      await client.query(
        `INSERT INTO questions (form_id, google_question_id, title, position) VALUES ($1, $2, $3, $4)
         ON CONFLICT (form_id, google_question_id) DO UPDATE SET title = EXCLUDED.title, position = EXCLUDED.position, removed_at = NULL`,
        [formId, q.googleQuestionId, q.title, q.position],
      );
    }
    await client.query(
      'UPDATE questions SET removed_at = now() WHERE form_id = $1 AND removed_at IS NULL AND NOT (google_question_id = ANY($2::text[]))',
      [formId, questions.map((q) => q.googleQuestionId)],
    );
    await applyFieldConfig(client, config, formId);

    for (const r of responses) {
      // Inserts new responses; updates only ones edited in Google; never touches taken-down rows.
      const { rows: written } = await client.query<{ inserted: boolean }>(
        `INSERT INTO submissions (form_id, google_response_id, answers, respondent_email, submitted_at, last_submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (google_response_id) DO UPDATE SET
           answers = EXCLUDED.answers,
           respondent_email = EXCLUDED.respondent_email,
           last_submitted_at = EXCLUDED.last_submitted_at,
           visibility = 'hidden',
           synced_at = now()
         WHERE submissions.deleted_at IS NULL AND submissions.last_submitted_at IS DISTINCT FROM EXCLUDED.last_submitted_at
         RETURNING (xmax = 0) AS inserted`,
        [formId, r.googleResponseId, r.answers, r.respondentEmail, r.submittedAt, r.lastSubmittedAt],
      );
      if (written[0]?.inserted) result.inserted++;
      else if (written[0]) result.updated++;
    }

    const ids = responses.map((r) => r.googleResponseId);
    result.removed =
      (
        await client.query(
          `UPDATE submissions SET removed_from_source_at = now(), visibility = 'hidden'
           WHERE form_id = $1 AND deleted_at IS NULL AND removed_from_source_at IS NULL AND NOT (google_response_id = ANY($2::text[]))`,
          [formId, ids],
        )
      ).rowCount ?? 0;
    // A response that reappears in Google (deleted by mistake, then restored) is no longer marked removed. It stays hidden.
    await client.query(
      'UPDATE submissions SET removed_from_source_at = NULL WHERE form_id = $1 AND removed_from_source_at IS NOT NULL AND google_response_id = ANY($2::text[])',
      [formId, ids],
    );

    await client.query('COMMIT');
    result.ok = true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    result.error = (err as Error).message.slice(0, 2000);
    console.error(`Sync failed for form ${googleFormId}: ${result.error}`);
  } finally {
    client.release();
  }

  await pool.query(
    `UPDATE sync_runs SET finished_at = now(), ok = $2, form_id = $3, fetched = $4, inserted = $5, updated = $6, removed = $7, error = $8 WHERE id = $1`,
    [runId, result.ok, result.ok ? formId : await existingFormId(pool, googleFormId), result.fetched, result.inserted, result.updated, result.removed, result.error ?? null],
  );
  return result;
}

async function existingFormId(pool: pg.Pool, googleFormId: string): Promise<string | null> {
  return (await pool.query<{ id: string }>('SELECT id FROM forms WHERE google_form_id = $1', [googleFormId])).rows[0]?.id ?? null;
}

/** Rejects a response missing the fields everything else depends on, so the whole run fails loudly instead of storing junk. */
function checkedResponse(r: GoogleResponse): GoogleResponse {
  if (typeof r?.responseId !== 'string' || r.responseId === '') throw new Error('Google returned a response without a responseId');
  for (const field of ['createTime', 'lastSubmittedTime'] as const) {
    if (Number.isNaN(Date.parse(r[field]))) throw new Error(`Response ${r.responseId} has an invalid ${field}`);
  }
  return r;
}
