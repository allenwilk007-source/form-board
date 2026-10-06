// Starts the built site (production mode) against the test database and checks who may see and do what.
// Needs `npm run build` first; `npm test` does that via tests/global-setup.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PEOPLE } from '../src/fake-google/data.ts';
import { createFakeSource } from '../src/fake-google/source.ts';
import { loadFormsConfig } from '../src/lib/forms-config.ts';
import { createSessionValue, SESSION_COOKIE } from '../src/lib/session.ts';
import { syncAll } from '../src/lib/sync.ts';
import { OWNER_URL, USER_URL } from './db.ts';

const PORT = 3917;
const BASE = `http://localhost:${PORT}`;
const OWNER = 'allenwilk007@gmail.com';
const SECRET = 'http-test-secret-that-is-at-least-32-characters';

let server: ChildProcess;
let pool: pg.Pool;

beforeAll(async () => {
  process.env.SESSION_SECRET = SECRET; // so this file can mint cookies the server accepts
  pool = new pg.Pool({ connectionString: OWNER_URL });
  server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: OWNER_URL, USER_DATABASE_URL: USER_URL, SESSION_SECRET: SECRET, OWNER_EMAILS: OWNER, DEV_SIGNIN: '1' },
    stdio: 'ignore',
    detached: true, // own process group, so afterAll can stop npx and the server it starts
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(BASE);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('The site did not start');
}, 30_000);
afterAll(async () => {
  if (server?.pid) process.kill(-server.pid, 'SIGTERM');
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE forms, questions, submissions, sync_runs RESTART IDENTITY CASCADE');
  await syncAll(pool, createFakeSource(), await loadFormsConfig());
});

const cookieFor = (email: string) => `${SESSION_COOKIE}=${createSessionValue(email)}`;
const get = (path: string, email?: string) => fetch(BASE + path, { redirect: 'manual', headers: email ? { cookie: cookieFor(email) } : {} });
const post = (path: string, opts: { email?: string; origin?: string | null; cookie?: string; body?: URLSearchParams } = {}) => {
  const headers: Record<string, string> = {};
  const cookie = opts.cookie ?? (opts.email ? cookieFor(opts.email) : undefined);
  if (cookie) headers.cookie = cookie;
  if (opts.origin !== null) headers.origin = opts.origin ?? BASE;
  return fetch(BASE + path, { method: 'POST', redirect: 'manual', headers, body: opts.body });
};
const firstId = async () => (await pool.query("SELECT id FROM submissions WHERE google_response_id = 'ideas-resp-001'")).rows[0].id as string;
const runCount = async () => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM sync_runs')).rows[0].n;

describe('owner pages', () => {
  const pages = async () => ['/owner', `/owner/submissions/${await firstId()}`];

  it('answer 401 when signed out', async () => {
    for (const p of await pages()) expect((await get(p)).status, p).toBe(401);
  });

  it('answer 403 to a signed-in person who is not the owner, without leaking data', async () => {
    for (const p of await pages()) {
      const res = await get(p, PEOPLE.alex);
      expect(res.status, p).toBe(403);
      const html = await res.text();
      for (const leak of ['ideas-resp-001', 'Community garden', PEOPLE.sam]) expect(html, p).not.toContain(leak);
    }
  });

  it('answer 401 to a forged session cookie naming the owner', async () => {
    const [payload] = createSessionValue(OWNER).split('.');
    const res = await fetch(BASE + '/owner', { headers: { cookie: `${SESSION_COOKIE}=${payload}.forged-signature` } });
    expect(res.status).toBe(401);
  });

  it('show the owner every submission and who it belongs to', async () => {
    const res = await get('/owner', OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('60 submissions, page 1 of 3');
    expect(html).toContain('nobody (typed email, not trusted)');
    expect(html).toContain('Sync log');
  });

  it('render answers as text, never as HTML', async () => {
    const html = await (await get(`/owner/submissions/${await firstId()}`, OWNER)).text();
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; Community garden');
    expect(html).not.toContain('<script>alert("xss")</script>');
  });

  it('cope with junk in the address', async () => {
    expect((await get('/owner?form=1%20OR%201%3D1&page=-3&q=%25', OWNER)).status).toBe(200);
    expect((await get('/owner/submissions/abc', OWNER)).status).toBe(404);
    expect((await get('/owner/submissions/999999', OWNER)).status).toBe(404);
  });
});

describe('owner actions', () => {
  it('"Sync now" refuses signed-out (401), non-owners (403) and other sites (403)', async () => {
    const before = await runCount();
    expect((await post('/api/owner/sync')).status).toBe(401);
    expect((await post('/api/owner/sync', { email: PEOPLE.alex })).status).toBe(403);
    expect((await post('/api/owner/sync', { email: OWNER, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('/api/owner/sync', { email: OWNER, origin: null })).status).toBe(403);
    expect(await runCount()).toBe(before);
  });

  it('"Sync now" runs a sync for the owner and returns to the sync log', async () => {
    const before = await runCount();
    const res = await post('/api/owner/sync', { email: OWNER });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/\/owner\?synced=ok#sync-log$/);
    expect(await runCount()).toBe(before + 4);
  });

  it('Delete refuses signed-out (401), non-owners (403) and other sites (403), leaving the submission intact', async () => {
    const id = await firstId();
    const path = `/api/owner/submissions/${id}/delete`;
    expect((await post(path)).status).toBe(401);
    expect((await post(path, { email: PEOPLE.alex })).status).toBe(403);
    expect((await post(path, { email: OWNER, origin: 'https://evil.example' })).status).toBe(403);
    expect((await pool.query('SELECT deleted_at FROM submissions WHERE id = $1', [id])).rows[0].deleted_at).toBeNull();
  });

  it('Delete wipes the submission for the owner', async () => {
    const id = await firstId();
    const res = await post(`/api/owner/submissions/${id}/delete`, { email: OWNER });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/\/owner\?deleted=1$/);
    expect((await pool.query('SELECT answers, deleted_at FROM submissions WHERE id = $1', [id])).rows[0]).toMatchObject({ answers: {} });
  });
});

describe('sign-in', () => {
  it('has no test-person switch in production, even with DEV_SIGNIN=1', async () => {
    const html = await (await get('/')).text();
    expect(html).not.toContain('Sign in as a test person');
    const res = await post('/api/dev-signin', { body: new URLSearchParams({ email: OWNER }) });
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('signing out clears the session cookie', async () => {
    const res = await post('/api/signout', { email: PEOPLE.alex });
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`${SESSION_COOKIE}=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)`, 'i'));
  });

  it('shows the owner a link to the owner area, and others not', async () => {
    expect(await (await get('/', OWNER)).text()).toContain('Open the owner area');
    expect(await (await get('/', PEOPLE.alex)).text()).not.toContain('Open the owner area');
  });
});
