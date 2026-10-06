import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FEEDBACK_FORM_ID, fakeForms, fakeResponses, IDEAS_FORM_ID, PEOPLE } from '../src/fake-google/data.ts';
import { collectsVerifiedEmails } from '../src/lib/google.ts';
import { createFakeSource } from '../src/fake-google/source.ts';
import { asUser } from '../src/lib/as-user.ts';
import { syncAll } from '../src/lib/sync.ts';
import { OWNER_URL, USER_URL } from './db.ts';

let owner: pg.Pool;
let web: pg.Pool;

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: OWNER_URL });
  web = new pg.Pool({ connectionString: USER_URL, max: 1 }); // one connection, so reuse between requests is exercised
});
afterAll(async () => {
  await owner.end();
  await web.end();
});
beforeEach(async () => {
  await owner.query('TRUNCATE forms, questions, submissions, sync_runs RESTART IDENTITY CASCADE');
  await syncAll(owner, createFakeSource());
});

/** What each person should see, worked out from the fake data directly (not from the database). */
const verifiedForms = new Set(fakeForms.filter(collectsVerifiedEmails).map((f) => f.formId));
const expectedIds = (email: string) =>
  Object.entries(fakeResponses)
    .filter(([formId]) => verifiedForms.has(formId))
    .flatMap(([, rs]) => rs.filter((r) => r.respondentEmail?.toLowerCase() === email).map((r) => r.responseId))
    .sort();
const visibleIds = (email: string) =>
  asUser(web, email, async (db) =>
    (await db.query<{ id: string }>('SELECT id FROM submissions')).rows.map((r) => r.id),
  ).then(async (ids) =>
    (await owner.query<{ google_response_id: string }>('SELECT google_response_id FROM submissions WHERE id = ANY($1::bigint[])', [ids])).rows
      .map((r) => r.google_response_id)
      .sort(),
  );
const ownerRow = async (googleResponseId: string) => (await owner.query('SELECT * FROM submissions WHERE google_response_id = $1', [googleResponseId])).rows[0];

describe('each person sees only their own submissions', () => {
  it.each(Object.entries(PEOPLE))('%s sees exactly their own', async (_, email) => {
    expect(await visibleIds(email)).toEqual(expectedIds(email));
  });

  it('gives Alex the three submissions sent from verified forms, including one with different capitals', async () => {
    expect(await visibleIds(PEOPLE.alex)).toEqual(['help-resp-003', 'ideas-resp-001', 'ideas-resp-005']);
  });

  it('matches the signed-in email regardless of capitals', async () => {
    expect(await visibleIds('ALEX.KIM@example.ORG')).toEqual(await visibleIds(PEOPLE.alex));
  });

  it('gives Jo, who never sent anything, no submissions but all four forms', async () => {
    expect(await visibleIds(PEOPLE.jo)).toEqual([]);
    const forms = await asUser(web, PEOPLE.jo, async (db) => (await db.query('SELECT title, accepting_responses FROM forms ORDER BY id')).rows);
    expect(forms.map((f) => [f.title, f.accepting_responses])).toEqual([
      ['Community Project Ideas', true],
      ['Volunteer Sign-up', true],
      ['Event Feedback', true],
      ['Help Requests', false],
    ]);
  });

  it('cannot open someone else\'s submission even with its exact ID', async () => {
    const samsId = (await owner.query("SELECT id FROM submissions WHERE google_response_id = 'vol-resp-001'")).rows[0].id;
    const seen = await asUser(web, PEOPLE.alex, async (db) => (await db.query('SELECT id, answers FROM submissions WHERE id = $1', [samsId])).rowCount);
    expect(seen).toBe(0);
  });

  it('never trusts a typed-in email: the feedback entry with Alex\'s address is not Alex\'s', async () => {
    const spoof = await ownerRow('fb-resp-001');
    expect(spoof.respondent_email).toBe(PEOPLE.alex);
    expect(spoof.owner_email).toBeNull();
    expect(await visibleIds(PEOPLE.alex)).not.toContain('fb-resp-001');
  });

  it('shows a submission with no email to nobody', async () => {
    expect((await ownerRow('ideas-resp-004')).owner_email).toBeNull();
    for (const email of Object.values(PEOPLE)) expect(await visibleIds(email)).not.toContain('ideas-resp-004');
  });

  it('hides a deleted submission and one removed in Google from their owner', async () => {
    await owner.query(
      "UPDATE submissions SET deleted_at = now(), answers = '{}', respondent_email = NULL, owner_email = NULL WHERE google_response_id = 'ideas-resp-001'",
    );
    await owner.query("UPDATE submissions SET removed_from_source_at = now() WHERE google_response_id = 'help-resp-003'");
    expect(await visibleIds(PEOPLE.alex)).toEqual(['ideas-resp-005']);
  });

  it('accounts for every submission: each one belongs to at most one person', async () => {
    const all = (await Promise.all(Object.values(PEOPLE).map(visibleIds))).flat();
    expect(new Set(all).size).toBe(all.length);
    const trusted = (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM submissions WHERE owner_email IS NOT NULL')).rows[0].n;
    const known = (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM submissions WHERE owner_email = ANY($1)', [Object.values(PEOPLE)])).rows[0].n;
    expect(all.length).toBe(known);
    expect(known).toBe(trusted);
  });
});

describe('signed out', () => {
  it('sees no forms, questions or submissions', async () => {
    for (const table of ['forms', 'questions', 'submissions']) {
      expect((await web.query(`SELECT id FROM ${table}`)).rowCount).toBe(0);
    }
  });

  it('does not inherit the previous request\'s email on a reused connection', async () => {
    expect((await visibleIds(PEOPLE.alex)).length).toBeGreaterThan(0);
    expect((await web.query('SELECT id FROM submissions')).rowCount).toBe(0); // same single pooled connection
  });

  it('treats an empty email as signed out', async () => {
    const client = await web.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_email', '', true)");
      expect((await client.query('SELECT id FROM submissions')).rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('refuses to run asUser without a real email', async () => {
    await expect(asUser(web, '', async () => 1)).rejects.toThrow(/signed-in email/);
    await expect(asUser(web, 'not-an-email', async () => 1)).rejects.toThrow(/signed-in email/);
  });
});

describe('what the web_user role cannot do', () => {
  it.each(['respondent_email', 'deleted_at', 'removed_from_source_at', 'google_response_id'])('cannot read submissions.%s', async (column) => {
    await expect(asUser(web, PEOPLE.alex, (db) => db.query(`SELECT ${column} FROM submissions`))).rejects.toThrow(/permission denied/);
  });

  it.each(['sync_runs', 'schema_migrations'])('cannot read %s', async (table) => {
    await expect(web.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
  });

  it('cannot read which forms trust emails', async () => {
    await expect(asUser(web, PEOPLE.alex, (db) => db.query('SELECT emails_verified FROM forms'))).rejects.toThrow(/permission denied/);
  });

  it.each([
    ["UPDATE submissions SET answers = '{}'"],
    ['DELETE FROM submissions'],
    ["INSERT INTO forms (google_form_id, title) VALUES ('x', 'x')"],
    ['CREATE TABLE sneaky (x int)'],
  ])('cannot write: %s', async (sql) => {
    const client = await web.connect();
    try {
      await client.query("SELECT set_config('app.user_email', $1, false)", [PEOPLE.alex]);
      await expect(client.query(sql)).rejects.toThrow(/permission denied|read-only/);
    } finally {
      await client.query("SELECT set_config('app.user_email', '', false)");
      client.release();
    }
  });
});

describe('removal requests', () => {
  it('refuses to mark a submission deleted while it still holds content', async () => {
    await expect(owner.query("UPDATE submissions SET deleted_at = now() WHERE google_response_id = 'ideas-resp-006'")).rejects.toThrow(
      /deleted_rows_hold_no_content/,
    );
  });
});

describe('email trust', () => {
  it('comes from each form\'s own setting: feedback collects typed emails, the rest verified ones', () => {
    expect(verifiedForms.has(FEEDBACK_FORM_ID)).toBe(false);
    expect(verifiedForms.has(IDEAS_FORM_ID)).toBe(true);
    expect(verifiedForms.size).toBe(3);
  });
});
