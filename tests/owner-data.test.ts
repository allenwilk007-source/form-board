import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HELP_FORM_ID, PEOPLE } from '../src/fake-google/data.ts';
import { createFakeSource } from '../src/fake-google/source.ts';
import { asUser } from '../src/lib/as-user.ts';
import { deleteSubmission, getSubmission, listForms, listSubmissions, madeForms, PAGE_SIZE, recentSyncRuns } from '../src/lib/owner-data.ts';
import { syncAll } from '../src/lib/sync.ts';
import { OWNER_URL, USER_URL } from './db.ts';

let pool: pg.Pool;
let web: pg.Pool;

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
  await syncAll(pool, createFakeSource());
});

const idOf = async (googleResponseId: string) => (await pool.query('SELECT id FROM submissions WHERE google_response_id = $1', [googleResponseId])).rows[0].id as string;

describe('listSubmissions', () => {
  it('lists all 60, newest first, in pages of 25', async () => {
    const p1 = await listSubmissions(pool, {});
    expect(p1).toMatchObject({ total: 60, page: 1, pages: 3 });
    expect(p1.rows).toHaveLength(PAGE_SIZE);
    const times = p1.rows.map((r) => r.submitted_at.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect((await listSubmissions(pool, { page: 3 })).rows).toHaveLength(10);
  });

  it('clamps a page number out of range', async () => {
    expect((await listSubmissions(pool, { page: 99 })).page).toBe(3);
    expect((await listSubmissions(pool, { page: -4 })).page).toBe(1);
    expect((await listSubmissions(pool, { page: Number.NaN })).page).toBe(1);
  });

  it('searches emails, including typed ones, ignoring case', async () => {
    const { rows } = await listSubmissions(pool, { q: 'ALEX.KIM' });
    expect(rows.map((r) => r.google_response_id).sort()).toEqual(['fb-resp-001', 'help-resp-003', 'ideas-resp-001', 'ideas-resp-005']);
  });

  it('searches answers and form titles', async () => {
    expect((await listSubmissions(pool, { q: 'compost' })).rows.map((r) => r.google_response_id)).toEqual(['ideas-resp-001']);
    expect((await listSubmissions(pool, { q: 'help requests' })).total).toBe(18);
  });

  it('treats % and _ in a search as plain characters', async () => {
    expect((await listSubmissions(pool, { q: '%' })).total).toBe(0);
    expect((await listSubmissions(pool, { q: '_' })).total).toBe(0);
  });

  it('filters by form, and ignores a malformed form ID', async () => {
    const help = (await listForms(pool)).find((f) => f.google_form_id === HELP_FORM_ID)!;
    expect((await listSubmissions(pool, { formId: help.id })).total).toBe(18);
    expect((await listSubmissions(pool, { formId: '1 OR 1=1' })).total).toBe(60);
  });
});

describe('listForms', () => {
  it('lists every form with its counts and settings', async () => {
    const forms = await listForms(pool);
    expect(forms.map((f) => [f.title, f.accepting_responses, f.emails_verified, f.submissions])).toEqual([
      ['Community Project Ideas', true, true, 24],
      ['Event Feedback', true, false, 8],
      ['Help Requests', false, true, 18],
      ['Volunteer Sign-up', true, true, 10],
    ]);
  });
});

describe('getSubmission', () => {
  it('returns the answers with the form\'s questions in order', async () => {
    const s = (await getSubmission(pool, await idOf('ideas-resp-001')))!;
    expect(s.form_title).toBe('Community Project Ideas');
    expect(s.questions.map((q) => q.title)).toEqual(['Project title', 'Describe your idea', 'Categories', 'Your name']);
    expect(s.answers.a1000001).toContain('<script>');
  });

  it('returns null for a missing or malformed ID', async () => {
    expect(await getSubmission(pool, '999999')).toBeNull();
    expect(await getSubmission(pool, 'abc')).toBeNull();
    expect(await getSubmission(pool, '1; DROP TABLE forms')).toBeNull();
  });
});

describe('deleteSubmission', () => {
  it('wipes the content, hides it from its sender, and survives the next sync', async () => {
    const id = await idOf('ideas-resp-001');
    expect(await deleteSubmission(pool, id)).toBe(true);
    const s = (await getSubmission(pool, id))!;
    expect(s).toMatchObject({ answers: {}, owner_email: null, respondent_email: null });
    expect(s.deleted_at).toBeInstanceOf(Date);
    const alexSees = () => asUser(web, PEOPLE.alex, async (db) => (await db.query('SELECT id FROM submissions WHERE id = $1', [id])).rowCount);
    expect(await alexSees()).toBe(0);
    await syncAll(pool, createFakeSource());
    expect((await getSubmission(pool, id))!.answers).toEqual({});
    expect(await alexSees()).toBe(0);
  });

  it('reports false when already deleted, missing or malformed', async () => {
    const id = await idOf('ideas-resp-002');
    await deleteSubmission(pool, id);
    expect(await deleteSubmission(pool, id)).toBe(false);
    expect(await deleteSubmission(pool, '999999')).toBe(false);
    expect(await deleteSubmission(pool, 'x')).toBe(false);
  });
});

describe('recentSyncRuns', () => {
  it('lists runs newest first with form titles', async () => {
    const runs = await recentSyncRuns(pool, 3);
    expect(runs).toHaveLength(3);
    expect(runs[0].form_title).toBe('Help Requests');
    expect(runs.every((r) => r.ok)).toBe(true);
  });
});

describe('madeForms', () => {
  it('lists the listed forms, open ones first, then by title', async () => {
    expect((await madeForms(pool)).map((f) => [f.title, f.accepting_responses])).toEqual([
      ['Community Project Ideas', true],
      ['Event Feedback', true],
      ['Volunteer Sign-up', true],
      ['Help Requests', false],
    ]);
  });

  it('leaves out a form that has dropped off the list', async () => {
    await pool.query("UPDATE forms SET listed = false WHERE title = 'Event Feedback'");
    expect((await madeForms(pool)).map((f) => f.title)).not.toContain('Event Feedback');
  });

  it("counts every live response, whether or not it could be matched to a person", async () => {
    const feedback = (await madeForms(pool)).find((f) => f.title === 'Event Feedback')!;
    // Its emails are not verified, so none of its responses belong to anyone — and all still count.
    expect(feedback).toMatchObject({ emails_verified: false, submissions: 8 });
  });

  it('stops counting a response once it is deleted or gone from Google', async () => {
    const before = (await madeForms(pool)).find((f) => f.title === 'Community Project Ideas')!.submissions;
    await deleteSubmission(pool, await idOf('ideas-resp-001'));
    await pool.query("UPDATE submissions SET removed_from_source_at = now() WHERE google_response_id = 'ideas-resp-002'");
    expect((await madeForms(pool)).find((f) => f.title === 'Community Project Ideas')!.submissions).toBe(before - 2);
  });

  it('carries the link people use to fill each form in', async () => {
    expect((await madeForms(pool)).find((f) => f.title === 'Volunteer Sign-up')!.responder_uri).toBe(
      'https://docs.google.com/forms/d/e/fake-form-volunteer/viewform',
    );
  });
});
