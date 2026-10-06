import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FEEDBACK_FORM_ID, fakeForms, fakeResponses, HELP_FORM_ID, IDEAS_FORM_ID, PEOPLE, Q, VOLUNTEER_FORM_ID } from '../src/fake-google/data.ts';
import { createFakeSource, type FakeSource } from '../src/fake-google/source.ts';
import { asUser } from '../src/lib/as-user.ts';
import { syncAll, syncForm } from '../src/lib/sync.ts';
import { OWNER_URL, USER_URL } from './db.ts';

let pool: pg.Pool;
let web: pg.Pool;
let source: FakeSource;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: OWNER_URL });
  web = new pg.Pool({ connectionString: USER_URL });
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
const form = async (googleFormId: string) => (await pool.query('SELECT * FROM forms WHERE google_form_id = $1', [googleFormId])).rows[0];
const sees = async (email: string, googleResponseId: string) =>
  asUser(web, email, async (db) => (await db.query('SELECT 1 FROM submissions WHERE id = $1', [(await row(googleResponseId)).id])).rowCount === 1);
const lastRun = async () => (await pool.query('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1')).rows[0];
const ALL = Object.keys(fakeResponses);

const newResponse = (id: string, email: string | undefined, title = 'Brand new idea') => ({
  responseId: id,
  createTime: '2026-10-06T09:00:00Z',
  lastSubmittedTime: '2026-10-06T09:00:00Z',
  ...(email ? { respondentEmail: email } : {}),
  answers: { [Q.ideaTitle]: { questionId: Q.ideaTitle, textAnswers: { answers: [{ value: title }] } } },
});

describe('backfill', () => {
  it('imports every response of every form, matching the source counts', async () => {
    const results = await syncAll(pool, source);
    expect(results.map((r) => [r.googleFormId, r.ok, r.inserted])).toEqual(ALL.map((id) => [id, true, fakeResponses[id].length]));
    for (const id of ALL) expect(await count('form_id = (SELECT id FROM forms WHERE google_form_id = $1)', [id])).toBe(fakeResponses[id].length);
  });

  it('stores each form\'s title, fill-in link, open state and email trust', async () => {
    await syncAll(pool, source);
    for (const f of fakeForms) {
      expect(await form(f.formId)).toMatchObject({
        title: f.info.title,
        responder_uri: f.responderUri,
        accepting_responses: f.formId !== HELP_FORM_ID,
        emails_verified: f.formId !== FEEDBACK_FORM_ID,
      });
    }
  });

  it('logs each run with its counts', async () => {
    await syncAll(pool, source);
    const { rows } = await pool.query('SELECT google_form_id, ok, fetched, inserted, updated, removed, error, finished_at FROM sync_runs ORDER BY id');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ google_form_id: IDEAS_FORM_ID, ok: true, fetched: 24, inserted: 24, updated: 0, removed: 0, error: null });
    expect(rows[3].finished_at).toBeInstanceOf(Date);
  });
});

describe('idempotency', () => {
  it('creates zero duplicates and changes nothing when run twice', async () => {
    await syncAll(pool, source);
    const before = (await pool.query('SELECT * FROM submissions ORDER BY id')).rows;
    const second = await syncAll(pool, source);
    expect(second.map((r) => [r.inserted, r.updated, r.removed])).toEqual(ALL.map(() => [0, 0, 0]));
    expect((await pool.query('SELECT * FROM submissions ORDER BY id')).rows).toEqual(before);
  });

  it('creates zero duplicates when two syncs run at the same time', async () => {
    const [a, b] = await Promise.all([syncForm(pool, source, IDEAS_FORM_ID), syncForm(pool, source, IDEAS_FORM_ID)]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.inserted + b.inserted).toBe(24);
    expect(await count()).toBe(24);
  });
});

describe('incremental sync', () => {
  it('shows a new response to its sender after the next sync', async () => {
    await syncAll(pool, source);
    source.addResponse(IDEAS_FORM_ID, newResponse('ideas-resp-new', PEOPLE.jo));
    expect(await syncForm(pool, source, IDEAS_FORM_ID)).toMatchObject({ ok: true, inserted: 1, updated: 0 });
    expect(await sees(PEOPLE.jo, 'ideas-resp-new')).toBe(true);
    expect(await sees(PEOPLE.alex, 'ideas-resp-new')).toBe(false);
  });

  it('replaces the answers of a response edited in Google', async () => {
    await syncAll(pool, source);
    source.editResponse(IDEAS_FORM_ID, 'ideas-resp-001', Q.ideaTitle, 'Changed title', '2026-10-06T12:00:00Z');
    expect(await syncForm(pool, source, IDEAS_FORM_ID)).toMatchObject({ ok: true, inserted: 0, updated: 1 });
    const r = await row('ideas-resp-001');
    expect(r.answers[Q.ideaTitle]).toBe('Changed title');
    expect(r.last_submitted_at.toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(await sees(PEOPLE.alex, 'ideas-resp-001')).toBe(true);
  });

  it('follows a form closing and reopening', async () => {
    await syncAll(pool, source);
    source.setAccepting(VOLUNTEER_FORM_ID, false);
    await syncForm(pool, source, VOLUNTEER_FORM_ID);
    expect((await form(VOLUNTEER_FORM_ID)).accepting_responses).toBe(false);
    source.setAccepting(VOLUNTEER_FORM_ID, true);
    await syncForm(pool, source, VOLUNTEER_FORM_ID);
    expect((await form(VOLUNTEER_FORM_ID)).accepting_responses).toBe(true);
  });

  it('re-decides ownership when a form\'s email setting changes in Google', async () => {
    await syncAll(pool, source);
    expect(await sees(PEOPLE.alex, 'fb-resp-001')).toBe(false);
    source.setEmailCollection(FEEDBACK_FORM_ID, 'VERIFIED');
    await syncForm(pool, source, FEEDBACK_FORM_ID);
    expect(await sees(PEOPLE.alex, 'fb-resp-001')).toBe(true);
    source.setEmailCollection(FEEDBACK_FORM_ID, 'RESPONDER_INPUT');
    await syncForm(pool, source, FEEDBACK_FORM_ID);
    expect(await sees(PEOPLE.alex, 'fb-resp-001')).toBe(false);
  });
});

describe('deletions', () => {
  it('hides a response deleted in Google from its sender, and shows it again if it comes back', async () => {
    await syncAll(pool, source);
    const saved = source.responses.get(IDEAS_FORM_ID)!.find((r) => r.responseId === 'ideas-resp-001')!;
    source.deleteResponse(IDEAS_FORM_ID, 'ideas-resp-001');
    expect(await syncForm(pool, source, IDEAS_FORM_ID)).toMatchObject({ ok: true, removed: 1 });
    expect((await row('ideas-resp-001')).removed_from_source_at).toBeInstanceOf(Date);
    expect(await sees(PEOPLE.alex, 'ideas-resp-001')).toBe(false);

    source.addResponse(IDEAS_FORM_ID, saved);
    await syncForm(pool, source, IDEAS_FORM_ID);
    expect((await row('ideas-resp-001')).removed_from_source_at).toBeNull();
    expect(await sees(PEOPLE.alex, 'ideas-resp-001')).toBe(true);
  });

  it('never re-imports a submission deleted here, and never restores its content', async () => {
    await syncAll(pool, source);
    await pool.query(
      "UPDATE submissions SET deleted_at = now(), answers = '{}', respondent_email = NULL, owner_email = NULL WHERE google_response_id = 'ideas-resp-001'",
    );
    source.editResponse(IDEAS_FORM_ID, 'ideas-resp-001', Q.ideaTitle, 'Edited after deletion', '2026-10-06T12:00:00Z');
    expect(await syncForm(pool, source, IDEAS_FORM_ID)).toMatchObject({ ok: true, inserted: 0, updated: 0 });
    expect(await count()).toBe(60);
    expect(await row('ideas-resp-001')).toMatchObject({ answers: {}, respondent_email: null, owner_email: null });
    expect(await sees(PEOPLE.alex, 'ideas-resp-001')).toBe(false);
  });

  it('refuses to remove everything when Google suddenly returns no responses', async () => {
    await syncAll(pool, source);
    source.responses.set(IDEAS_FORM_ID, []);
    const result = await syncForm(pool, source, IDEAS_FORM_ID);
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/refusing/);
    expect(await count('removed_from_source_at IS NOT NULL')).toBe(0);
    expect(await sees(PEOPLE.alex, 'ideas-resp-001')).toBe(true);
  });
});

describe('form changes', () => {
  it('keeps syncing when a question is added, and stores its answers', async () => {
    await syncAll(pool, source);
    source.addQuestion(IDEAS_FORM_ID, 'a1000099', 'Your postcode');
    source.editResponse(IDEAS_FORM_ID, 'ideas-resp-001', 'a1000099', 'AB1 2CD', '2026-10-06T12:00:00Z');
    expect(await syncForm(pool, source, IDEAS_FORM_ID)).toMatchObject({ ok: true });
    expect((await pool.query("SELECT title FROM questions WHERE google_question_id = 'a1000099'")).rows).toEqual([{ title: 'Your postcode' }]);
    expect((await row('ideas-resp-001')).answers.a1000099).toBe('AB1 2CD');
  });

  it('follows a renamed question by its ID', async () => {
    await syncAll(pool, source);
    source.renameQuestion(IDEAS_FORM_ID, Q.ideaTitle, 'Name of your project');
    await syncForm(pool, source, IDEAS_FORM_ID);
    expect((await pool.query('SELECT title FROM questions WHERE google_question_id = $1', [Q.ideaTitle])).rows).toEqual([{ title: 'Name of your project' }]);
  });

  it('marks a removed question as removed and keeps its old answers', async () => {
    await syncAll(pool, source);
    source.removeQuestion(IDEAS_FORM_ID, Q.ideaDescription);
    await syncForm(pool, source, IDEAS_FORM_ID);
    expect((await pool.query('SELECT removed_at FROM questions WHERE google_question_id = $1', [Q.ideaDescription])).rows[0].removed_at).toBeInstanceOf(Date);
    expect((await row('ideas-resp-010')).answers[Q.ideaDescription]).toContain('Idea number 10');
  });
});

describe('form discovery', () => {
  it('syncs exactly the forms the source lists', async () => {
    source.setListed(VOLUNTEER_FORM_ID, false);
    const results = await syncAll(pool, source);
    expect(results.map((r) => r.googleFormId)).not.toContain(VOLUNTEER_FORM_ID);
    expect(await form(VOLUNTEER_FORM_ID)).toBeUndefined();
  });

  it('marks a form that drops out of the list as unlisted, keeping its submissions, and relists it when it returns', async () => {
    await syncAll(pool, source);
    source.setListed(IDEAS_FORM_ID, false);
    await syncAll(pool, source);
    expect((await form(IDEAS_FORM_ID)).listed).toBe(false);
    expect(await count('form_id = (SELECT id FROM forms WHERE google_form_id = $1)', [IDEAS_FORM_ID])).toBe(24);
    expect(await sees(PEOPLE.alex, 'ideas-resp-001')).toBe(true);
    source.setListed(IDEAS_FORM_ID, true);
    await syncAll(pool, source);
    expect((await form(IDEAS_FORM_ID)).listed).toBe(true);
  });

  it('logs a failure to list the forms and changes nothing', async () => {
    await syncAll(pool, source);
    source.failNextList('Google API 403 for /drive/v3/files: insufficient permissions');
    const results = await syncAll(pool, source);
    expect(results).toEqual([expect.objectContaining({ googleFormId: '(list of forms)', ok: false })]);
    expect(await lastRun()).toMatchObject({ google_form_id: '(list of forms)', ok: false, error: 'Google API 403 for /drive/v3/files: insufficient permissions' });
    expect((await pool.query('SELECT count(*)::int AS n FROM forms WHERE listed')).rows[0].n).toBe(4);
  });
});

describe('failures', () => {
  it('logs a failed run, rolls back its changes, and still syncs the other forms', async () => {
    await syncAll(pool, source);
    source.addResponse(IDEAS_FORM_ID, newResponse('ideas-resp-new', PEOPLE.jo, 'Should not land'));
    source.failNext(IDEAS_FORM_ID, 'Google API quota exceeded');
    source.addResponse(HELP_FORM_ID, { ...structuredClone(fakeResponses[HELP_FORM_ID][0]), responseId: 'help-resp-new' });
    const [ideas, , , help] = await syncAll(pool, source);
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
    await syncForm(pool, source, IDEAS_FORM_ID);
    expect(await lastRun()).toMatchObject({ google_form_id: IDEAS_FORM_ID, ok: false, form_id: null, error: 'The caller does not have permission' });
  });

  it('fails the whole run, writing nothing, if any response is malformed', async () => {
    source.addResponse(IDEAS_FORM_ID, { ...newResponse('x', undefined), responseId: '' });
    expect(await syncForm(pool, source, IDEAS_FORM_ID)).toMatchObject({ ok: false, error: 'Google returned a response without a responseId' });
    expect(await count()).toBe(0);
  });

  it('fails the run if a timestamp is invalid', async () => {
    source.addResponse(IDEAS_FORM_ID, { ...newResponse('y', undefined), createTime: 'yesterday' });
    expect(await syncForm(pool, source, IDEAS_FORM_ID)).toMatchObject({ ok: false, error: 'Response y has an invalid createTime' });
  });
});
