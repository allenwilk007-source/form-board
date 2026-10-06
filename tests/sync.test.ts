import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeResponses, HELP_FORM_ID, IDEAS_FORM_ID, KNOWN_PRIVATE_VALUES, Q } from '../src/fake-google/data.ts';
import { createFakeSource, type FakeSource } from '../src/fake-google/source.ts';
import { loadFieldConfig, type FieldConfig } from '../src/lib/fields.ts';
import { syncAll, syncForm } from '../src/lib/sync.ts';
import { connect, OWNER_URL, PUBLIC_URL } from './db.ts';

let pool: pg.Pool;
let web: pg.Client;
let config: FieldConfig;
let source: FakeSource;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: OWNER_URL });
  web = await connect(PUBLIC_URL);
  config = await loadFieldConfig();
});
afterAll(async () => {
  await pool.end();
  await web.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE forms, questions, submissions, sync_runs RESTART IDENTITY CASCADE');
  source = createFakeSource();
});

const count = async (where = 'true', params: unknown[] = []) =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM submissions WHERE ${where}`, params)).rows[0].n;
const row = async (googleResponseId: string) => (await pool.query('SELECT * FROM submissions WHERE google_response_id = $1', [googleResponseId])).rows[0];
const publish = (googleResponseId: string) => pool.query("UPDATE submissions SET visibility = 'published' WHERE google_response_id = $1", [googleResponseId]);
const isPublic = async (googleResponseId: string) =>
  (await web.query('SELECT 1 FROM public_submissions WHERE id = $1', [(await row(googleResponseId)).id])).rowCount === 1;
const lastRun = async () => (await pool.query('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1')).rows[0];

const newResponse = (id: string, title: string) => ({
  responseId: id,
  createTime: '2026-10-06T09:00:00Z',
  lastSubmittedTime: '2026-10-06T09:00:00Z',
  answers: {
    [Q.ideaTitle]: { questionId: Q.ideaTitle, textAnswers: { answers: [{ value: title }] } },
    [Q.ideaEmail]: { questionId: Q.ideaEmail, textAnswers: { answers: [{ value: 'brand.new@example.com' }] } },
  },
});

describe('backfill', () => {
  it('imports every response of every form, all hidden and pending', async () => {
    const results = await syncAll(pool, source, config);
    expect(results.map((r) => [r.googleFormId, r.ok, r.inserted])).toEqual([
      [IDEAS_FORM_ID, true, fakeResponses[IDEAS_FORM_ID].length],
      [HELP_FORM_ID, true, fakeResponses[HELP_FORM_ID].length],
    ]);
    for (const formId of [IDEAS_FORM_ID, HELP_FORM_ID]) {
      expect(await count('form_id = (SELECT id FROM forms WHERE google_form_id = $1)', [formId])).toBe(fakeResponses[formId].length);
    }
    expect(await count("visibility = 'hidden' AND status = 'pending'")).toBe(60);
    expect((await web.query('SELECT count(*)::int AS n FROM public_submissions')).rows[0].n).toBe(0);
  });

  it('logs each run with its counts', async () => {
    await syncAll(pool, source, config);
    const { rows } = await pool.query('SELECT google_form_id, ok, fetched, inserted, updated, removed, error, finished_at FROM sync_runs ORDER BY id');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ google_form_id: IDEAS_FORM_ID, ok: true, fetched: 36, inserted: 36, updated: 0, removed: 0, error: null });
    expect(rows[1].finished_at).toBeInstanceOf(Date);
  });
});

describe('idempotency', () => {
  it('creates zero duplicates and changes nothing when run twice', async () => {
    await syncAll(pool, source, config);
    const before = (await pool.query('SELECT id, answers, synced_at FROM submissions ORDER BY id')).rows;
    const second = await syncAll(pool, source, config);
    expect(second.map((r) => [r.inserted, r.updated, r.removed])).toEqual([[0, 0, 0], [0, 0, 0]]);
    expect((await pool.query('SELECT id, answers, synced_at FROM submissions ORDER BY id')).rows).toEqual(before);
    expect(await count()).toBe(60);
  });

  it('creates zero duplicates when two syncs run at the same time', async () => {
    const [a, b] = await Promise.all([syncForm(pool, source, IDEAS_FORM_ID, config), syncForm(pool, source, IDEAS_FORM_ID, config)]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.inserted + b.inserted).toBe(36);
    expect(await count()).toBe(36);
  });

  it('keeps an approved submission published when nothing changed', async () => {
    await syncAll(pool, source, config);
    await publish('ideas-resp-005');
    await syncAll(pool, source, config);
    expect(await isPublic('ideas-resp-005')).toBe(true);
  });
});

describe('incremental sync', () => {
  it('adds a new response hidden, without touching the others', async () => {
    await syncAll(pool, source, config);
    source.addResponse(IDEAS_FORM_ID, newResponse('ideas-resp-new', 'Brand new idea'));
    const result = await syncForm(pool, source, IDEAS_FORM_ID, config);
    expect(result).toMatchObject({ ok: true, inserted: 1, updated: 0 });
    expect(await row('ideas-resp-new')).toMatchObject({ visibility: 'hidden', status: 'pending' });
    expect(await count()).toBe(61);
  });

  it('updates an edited response and hides it again until re-approved, keeping its status', async () => {
    await syncAll(pool, source, config);
    await publish('ideas-resp-006');
    await pool.query("UPDATE submissions SET status = 'resolved' WHERE google_response_id = 'ideas-resp-006'");
    source.editResponse(IDEAS_FORM_ID, 'ideas-resp-006', Q.ideaTitle, 'Changed title', '2026-10-06T12:00:00Z');
    const result = await syncForm(pool, source, IDEAS_FORM_ID, config);
    expect(result).toMatchObject({ ok: true, inserted: 0, updated: 1 });
    const r = await row('ideas-resp-006');
    expect(r.answers[Q.ideaTitle]).toBe('Changed title');
    expect(r).toMatchObject({ visibility: 'hidden', status: 'resolved' });
    expect(r.last_submitted_at.toISOString()).toBe('2026-10-06T12:00:00.000Z');
  });
});

describe('deletions', () => {
  it('hides and marks a response deleted in Google Forms, and keeps it hidden if it comes back', async () => {
    await syncAll(pool, source, config);
    await publish('ideas-resp-007');
    const saved = source.responses.get(IDEAS_FORM_ID)!.find((r) => r.responseId === 'ideas-resp-007')!;
    source.deleteResponse(IDEAS_FORM_ID, 'ideas-resp-007');
    expect(await syncForm(pool, source, IDEAS_FORM_ID, config)).toMatchObject({ ok: true, removed: 1 });
    expect(await row('ideas-resp-007')).toMatchObject({ visibility: 'hidden' });
    expect((await row('ideas-resp-007')).removed_from_source_at).toBeInstanceOf(Date);
    expect(await isPublic('ideas-resp-007')).toBe(false);

    source.addResponse(IDEAS_FORM_ID, saved);
    await syncForm(pool, source, IDEAS_FORM_ID, config);
    expect(await row('ideas-resp-007')).toMatchObject({ visibility: 'hidden', removed_from_source_at: null });
  });

  it('never re-imports a submission taken down here, and never restores its content', async () => {
    await syncAll(pool, source, config);
    await pool.query(
      "UPDATE submissions SET deleted_at = now(), answers = '{}', respondent_email = NULL, visibility = 'hidden' WHERE google_response_id = 'ideas-resp-003'",
    );
    source.editResponse(IDEAS_FORM_ID, 'ideas-resp-003', Q.ideaTitle, 'Edited after takedown', '2026-10-06T12:00:00Z');
    const result = await syncForm(pool, source, IDEAS_FORM_ID, config);
    expect(result).toMatchObject({ ok: true, inserted: 0, updated: 0 });
    expect(await count()).toBe(60);
    expect((await row('ideas-resp-003')).answers).toEqual({});
    expect(JSON.stringify((await pool.query('SELECT answers, respondent_email FROM submissions')).rows)).not.toContain('private.test@example.com');
  });

  it('refuses to hide everything when Google suddenly returns no responses', async () => {
    await syncAll(pool, source, config);
    await publish('ideas-resp-008');
    source.responses.set(IDEAS_FORM_ID, []);
    const result = await syncForm(pool, source, IDEAS_FORM_ID, config);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refusing/);
    expect(await isPublic('ideas-resp-008')).toBe(true);
    expect(await count('removed_from_source_at IS NOT NULL')).toBe(0);
  });
});

describe('form changes', () => {
  it('keeps syncing when a question is added, and the new question is private', async () => {
    await syncAll(pool, source, config);
    source.addQuestion(IDEAS_FORM_ID, 'a1000099', 'Your home address');
    source.editResponse(IDEAS_FORM_ID, 'ideas-resp-009', 'a1000099', '1 Secret Street', '2026-10-06T12:00:00Z');
    expect(await syncForm(pool, source, IDEAS_FORM_ID, config)).toMatchObject({ ok: true });
    await publish('ideas-resp-009');
    const q = (await pool.query("SELECT * FROM questions WHERE google_question_id = 'a1000099'")).rows[0];
    expect(q).toMatchObject({ title: 'Your home address', is_public: false });
    expect((await row('ideas-resp-009')).answers.a1000099).toBe('1 Secret Street');
    expect(await isPublic('ideas-resp-009')).toBe(true);
    const visible = JSON.stringify([(await web.query('SELECT * FROM public_submissions')).rows, (await web.query('SELECT * FROM public_forms')).rows]);
    expect(visible).not.toContain('1 Secret Street');
    expect(visible).not.toContain('Your home address');
  });

  it('follows a renamed question by its ID and keeps it public', async () => {
    await syncAll(pool, source, config);
    source.renameQuestion(IDEAS_FORM_ID, Q.ideaTitle, 'Name of your project');
    expect(await syncForm(pool, source, IDEAS_FORM_ID, config)).toMatchObject({ ok: true });
    const titles = (await pool.query('SELECT title, is_public FROM questions WHERE google_question_id = $1', [Q.ideaTitle])).rows;
    expect(titles).toEqual([{ title: 'Name of your project', is_public: true }]);
  });

  it('marks a removed question as removed and keeps its old answers', async () => {
    await syncAll(pool, source, config);
    source.removeQuestion(IDEAS_FORM_ID, Q.ideaDescription);
    expect(await syncForm(pool, source, IDEAS_FORM_ID, config)).toMatchObject({ ok: true });
    const q = (await pool.query('SELECT removed_at FROM questions WHERE google_question_id = $1', [Q.ideaDescription])).rows[0];
    expect(q.removed_at).toBeInstanceOf(Date);
    expect((await row('ideas-resp-010')).answers[Q.ideaDescription]).toContain('Idea number 10');
  });
});

describe('failures', () => {
  it('logs a failed run, rolls back its changes, and still syncs the other forms', async () => {
    await syncAll(pool, source, config);
    source.addResponse(IDEAS_FORM_ID, newResponse('ideas-resp-new', 'Should not land'));
    source.failNext(IDEAS_FORM_ID, 'Google API quota exceeded');
    source.addResponse(HELP_FORM_ID, { ...structuredClone(fakeResponses[HELP_FORM_ID][0]), responseId: 'help-resp-new' });
    const [ideas, help] = await syncAll(pool, source, config);
    expect(ideas).toMatchObject({ ok: false, error: 'Google API quota exceeded' });
    expect(help).toMatchObject({ ok: true, inserted: 1 });
    expect(await row('ideas-resp-new')).toBeUndefined();
    const failed = (await pool.query('SELECT * FROM sync_runs WHERE ok = false')).rows;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ google_form_id: IDEAS_FORM_ID, error: 'Google API quota exceeded' });
    expect(failed[0].finished_at).toBeInstanceOf(Date);
  });

  it('logs a failure for a form that has never synced', async () => {
    source.failNext(IDEAS_FORM_ID, 'The caller does not have permission');
    await syncForm(pool, source, IDEAS_FORM_ID, config);
    expect(await lastRun()).toMatchObject({ google_form_id: IDEAS_FORM_ID, ok: false, form_id: null, error: 'The caller does not have permission' });
  });

  it('fails the whole run, writing nothing, if any response is malformed', async () => {
    source.addResponse(IDEAS_FORM_ID, { ...newResponse('x', 'Bad'), responseId: '' });
    const result = await syncForm(pool, source, IDEAS_FORM_ID, config);
    expect(result).toMatchObject({ ok: false, error: 'Google returned a response without a responseId' });
    expect(await count()).toBe(0);
  });

  it('fails the run if a timestamp is invalid', async () => {
    source.addResponse(IDEAS_FORM_ID, { ...newResponse('y', 'Bad'), createTime: 'yesterday' });
    expect(await syncForm(pool, source, IDEAS_FORM_ID, config)).toMatchObject({ ok: false, error: 'Response y has an invalid createTime' });
  });
});

describe('privacy after sync', () => {
  it('shows no planted private value publicly even with everything published', async () => {
    await syncAll(pool, source, config);
    await pool.query("UPDATE submissions SET visibility = 'published'");
    const visible = JSON.stringify([(await web.query('SELECT * FROM public_submissions')).rows, (await web.query('SELECT * FROM public_forms')).rows]);
    for (const value of KNOWN_PRIVATE_VALUES) expect(visible).not.toContain(value);
    expect(visible).not.toContain(Q.helpUrgency);
  });
});
