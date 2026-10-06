import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HELP_FORM_ID, IDEAS_FORM_ID, KNOWN_PRIVATE_VALUES, Q } from '../src/fake-google/data.ts';
import { applyFieldConfig, loadFieldConfig, parseFieldConfig, type FieldConfig } from '../src/lib/fields.ts';
import { seedDemo } from '../src/lib/seed-demo.ts';
import { connect, OWNER_URL, PUBLIC_URL } from './db.ts';

let owner: pg.Client;
let web: pg.Client;
let config: FieldConfig;

beforeAll(async () => {
  owner = await connect(OWNER_URL);
  web = await connect(PUBLIC_URL);
  config = await loadFieldConfig();
});
afterAll(async () => {
  await owner.end();
  await web.end();
});
beforeEach(async () => {
  await seedDemo(owner, config);
});

const publicIds = (formId: string) => config.forms[formId].public.map((f) => f.id);
const everythingPublic = async () => JSON.stringify([(await web.query('SELECT * FROM public_forms')).rows, (await web.query('SELECT * FROM public_submissions')).rows]);
const publishedId = async (googleResponseId: string) =>
  (await owner.query<{ id: string }>('SELECT id FROM submissions WHERE google_response_id = $1', [googleResponseId])).rows[0].id;
const isPublic = async (id: string) => (await web.query('SELECT 1 FROM public_submissions WHERE id = $1', [id])).rowCount === 1;

describe('the public database role', () => {
  it.each(['forms', 'questions', 'submissions', 'sync_runs', 'schema_migrations'])('cannot read the %s table', async (table) => {
    await expect(web.query(`SELECT * FROM ${table}`)).rejects.toThrow(/permission denied/);
  });

  it('sees zero rows even if a table grant is added by mistake (row-level security)', async () => {
    await owner.query('GRANT SELECT ON submissions TO web_public');
    try {
      expect((await web.query('SELECT * FROM submissions')).rowCount).toBe(0);
    } finally {
      await owner.query('REVOKE SELECT ON submissions FROM web_public');
    }
  });

  it('cannot create tables or functions', async () => {
    await expect(web.query('CREATE TABLE sneaky (x int)')).rejects.toThrow(/permission denied/);
    await expect(web.query('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql')).rejects.toThrow(/permission denied/);
  });
});

describe('public_submissions', () => {
  it('holds only answers to questions listed as public', async () => {
    const { rows } = await web.query<{ form_id: string; answers: Record<string, unknown> }>(
      'SELECT s.form_id, s.answers, f.title FROM public_submissions s JOIN public_forms f ON f.id = s.form_id',
    );
    expect(rows.length).toBeGreaterThan(0);
    const formIds = Object.fromEntries((await owner.query('SELECT id, google_form_id FROM forms')).rows.map((r) => [r.id, r.google_form_id]));
    for (const row of rows) {
      for (const key of Object.keys(row.answers)) expect(publicIds(formIds[row.form_id])).toContain(key);
    }
  });

  it('never contains a planted private value, although the database does', async () => {
    const all = JSON.stringify((await owner.query('SELECT answers, respondent_email FROM submissions')).rows);
    const visible = await everythingPublic();
    for (const value of KNOWN_PRIVATE_VALUES) {
      expect(all).toContain(value); // proves the check below is not vacuous
      expect(visible).not.toContain(value);
    }
  });

  it('leaves out hidden submissions', async () => {
    const id = await publishedId('ideas-resp-001');
    expect(await isPublic(id)).toBe(true);
    await owner.query("UPDATE submissions SET visibility = 'hidden' WHERE id = $1", [id]);
    expect(await isPublic(id)).toBe(false);
  });

  it('leaves out taken-down submissions', async () => {
    const id = await publishedId('ideas-resp-002');
    await owner.query("UPDATE submissions SET deleted_at = now(), answers = '{}', respondent_email = NULL, visibility = 'hidden' WHERE id = $1", [id]);
    expect(await isPublic(id)).toBe(false);
  });

  it('leaves out submissions deleted in Google Forms, even if still marked published', async () => {
    const id = await publishedId('ideas-resp-003');
    await owner.query('UPDATE submissions SET removed_from_source_at = now() WHERE id = $1', [id]);
    expect(await isPublic(id)).toBe(false);
  });

  it('keeps HTML in answers as plain stored text, unchanged', async () => {
    const id = await publishedId('ideas-resp-001');
    const { rows } = await web.query('SELECT answers FROM public_submissions WHERE id = $1', [id]);
    expect(rows[0].answers[Q.ideaTitle]).toBe('<script>alert("xss")</script> Community garden');
  });
});

describe('field visibility config', () => {
  it('treats a question missing from the config as private (Urgency, added to the form later)', async () => {
    expect((await owner.query(`SELECT count(*)::int AS n FROM submissions WHERE answers ? '${Q.helpUrgency}'`)).rows[0].n).toBe(12);
    expect(await everythingPublic()).not.toContain(Q.helpUrgency);
    expect(await everythingPublic()).not.toContain('Urgency');
  });

  it('never shows the titles of private questions', async () => {
    const forms = JSON.stringify((await web.query('SELECT * FROM public_forms')).rows);
    expect(forms).toContain('Project title');
    for (const title of ['Your name', 'Your email', 'Phone number']) expect(forms).not.toContain(title);
  });

  it('makes a question private as soon as it is removed from the config', async () => {
    const narrowed = structuredClone(config);
    narrowed.forms[IDEAS_FORM_ID].public = narrowed.forms[IDEAS_FORM_ID].public.filter((f) => f.id !== Q.ideaDescription);
    await applyFieldConfig(owner, narrowed);
    expect(await everythingPublic()).not.toContain(Q.ideaDescription);
    expect(await everythingPublic()).toContain(Q.ideaTitle);
  });

  it('shows no answers for a form missing from the config', async () => {
    await applyFieldConfig(owner, { forms: { [IDEAS_FORM_ID]: config.forms[IDEAS_FORM_ID] } });
    const helpForm = (await owner.query('SELECT id FROM forms WHERE google_form_id = $1', [HELP_FORM_ID])).rows[0].id;
    const { rows } = await web.query('SELECT answers FROM public_submissions WHERE form_id = $1', [helpForm]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.answers).toEqual({});
  });

  it.each([
    ['not an object', null],
    ['no forms', {}],
    ['public is not a list', { forms: { f: { public: 'a1000001' } } }],
    ['an entry without an id', { forms: { f: { public: [{ label: 'Title' }] } } }],
    ['an empty id', { forms: { f: { public: [{ id: '', label: 'Title' }] } } }],
  ])('rejects a malformed config: %s', (_, raw) => {
    expect(() => parseFieldConfig(raw)).toThrow(/config\/fields.json is invalid/);
  });
});

describe('takedown rule', () => {
  it('refuses to mark a submission deleted while it still holds content', async () => {
    const id = await publishedId('ideas-resp-004');
    await expect(owner.query('UPDATE submissions SET deleted_at = now() WHERE id = $1', [id])).rejects.toThrow(/deleted_rows_hold_no_content/);
  });
});

describe('demo seed', () => {
  it('imports every fake response exactly once', async () => {
    expect((await owner.query('SELECT count(*)::int AS n FROM submissions')).rows[0].n).toBe(60);
    expect((await owner.query('SELECT count(DISTINCT google_response_id)::int AS n FROM submissions')).rows[0].n).toBe(60);
  });
});
