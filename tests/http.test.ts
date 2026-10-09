// Starts the built site (production mode) against the test database and checks who may see and do what.
// Needs `npm run build` first; `npm test` does that via tests/global-setup.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PEOPLE } from '../src/fake-google/data.ts';
import { showDate } from '../src/lib/format.ts';
import { createFakeSource } from '../src/fake-google/source.ts';
import { createSessionValue, createSignInValue, readSignInValue, SESSION_COOKIE, SIGNIN_COOKIE } from '../src/lib/session.ts';
import { syncAll } from '../src/lib/sync.ts';
import { OWNER_URL, USER_URL } from './db.ts';

const PORT = 3917;
const BASE = `http://localhost:${PORT}`;
const OWNER = 'allenwilk007@gmail.com';
const SECRET = 'http-test-secret-that-is-at-least-32-characters';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const REDIRECT_URI = `http://localhost:${PORT}/api/auth/google/callback`;

let server: ChildProcess;
let pool: pg.Pool;

beforeAll(async () => {
  process.env.SESSION_SECRET = SECRET; // so this file can mint cookies the server accepts
  pool = new pg.Pool({ connectionString: OWNER_URL });
  server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: OWNER_URL,
      USER_DATABASE_URL: USER_URL,
      SESSION_SECRET: SECRET,
      OWNER_EMAILS: OWNER,
      DEV_SIGNIN: '1',
      // Pinned, not inherited: with FORMS_SOURCE=google in the surrounding environment these tests
      // would sync the owner's real forms over the network and never match the fake data they assert.
      FORMS_SOURCE: 'fake',
      // Enough for the site to offer Google sign-in. No real approval is ever exchanged here, and
      // blanking the owner's refresh token means a mistake above fails loudly instead of quietly
      // reading real data.
      GOOGLE_CLIENT_ID: CLIENT_ID,
      GOOGLE_CLIENT_SECRET: 'secret-xyz',
      GOOGLE_REDIRECT_URI: REDIRECT_URI,
      GOOGLE_REFRESH_TOKEN: '',
    },
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
  await syncAll(pool, createFakeSource());
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

  it('offers Google sign-in to a signed-out visitor', async () => {
    const html = await (await get('/')).text();
    expect(html).toContain('action="/api/auth/google/start"');
    expect(html).toContain('Sign in with Google');
  });

  it('starts sign-in by sending the person to Google, remembering the attempt in a cookie', async () => {
    const res = await post('/api/auth/google/start');
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(to.searchParams.get('scope')).toBe('openid email');
    expect(to.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(to.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    // The visitor is never asked for access to the owner's files.
    expect(to.toString()).not.toMatch(/drive|forms\.body|forms\.responses/);
    // The state in the cookie is the one sent to Google, and the cookie is not readable by scripts.
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain(`${SIGNIN_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    const value = decodeURIComponent(setCookie.split(`${SIGNIN_COOKIE}=`)[1].split(';')[0]);
    expect(readSignInValue(value)).toEqual({ state: to.searchParams.get('state'), nonce: to.searchParams.get('nonce') });
  });

  it('gives every sign-in attempt its own state and nonce', async () => {
    const first = new URL((await post('/api/auth/google/start')).headers.get('location')!).searchParams;
    const second = new URL((await post('/api/auth/google/start')).headers.get('location')!).searchParams;
    expect(first.get('state')).not.toBe(second.get('state'));
    expect(first.get('nonce')).not.toBe(second.get('nonce'));
    expect(first.get('state')!.length).toBeGreaterThanOrEqual(32);
  });

  it('refuses to start a sign-in asked for by another site', async () => {
    const res = await post('/api/auth/google/start', { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  describe('the callback from Google', () => {
    const callback = (query: string, cookie?: string) =>
      fetch(`${BASE}/api/auth/google/callback?${query}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    const signInCookie = (state: string, nonce = 'nonce-1') => `${SIGNIN_COOKIE}=${encodeURIComponent(createSignInValue(state, nonce))}`;
    const signedIn = (res: Response) => (res.headers.get('set-cookie') ?? '').includes(`${SESSION_COOKIE}=`);

    it('refuses a callback with no sign-in under way', async () => {
      const res = await callback('code=c&state=st-1');
      expect(res.status).toBe(403);
      expect(signedIn(res)).toBe(false);
    });

    it('refuses a state that does not match the one it started with', async () => {
      const res = await callback('code=c&state=someone-elses-state', signInCookie('st-1'));
      expect(res.status).toBe(403);
      expect(signedIn(res)).toBe(false);
    });

    it('refuses a callback with no state at all', async () => {
      const res = await callback('code=c', signInCookie('st-1'));
      expect(res.status).toBe(403);
      expect(signedIn(res)).toBe(false);
    });

    it('refuses a matching state that brings no code', async () => {
      const res = await callback('state=st-1', signInCookie('st-1'));
      expect(res.status).toBe(403);
      expect(signedIn(res)).toBe(false);
    });

    it('refuses a sign-in cookie signed with the wrong secret', async () => {
      const [payload] = createSignInValue('st-1', 'nonce-1').split('.');
      const res = await callback('code=c&state=st-1', `${SIGNIN_COOKIE}=${payload}.forged-signature`);
      expect(res.status).toBe(403);
      expect(signedIn(res)).toBe(false);
    });

    it('sends someone who cancelled back to the sign-in page, not signed in', async () => {
      const res = await callback('error=access_denied', signInCookie('st-1'));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toMatch(/\/\?signin=denied$/);
      expect(signedIn(res)).toBe(false);
    });

    it('clears the sign-in cookie whatever the outcome, so a state is good for one try only', async () => {
      const cookie = signInCookie('st-1');
      const first = await callback('code=c&state=wrong', cookie);
      expect(first.headers.get('set-cookie')).toMatch(new RegExp(`${SIGNIN_COOKIE}=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)`, 'i'));
      // The browser would have dropped it; a replay therefore arrives with nothing under way.
      expect((await callback('code=c&state=st-1')).status).toBe(403);
    });
  });

  it('signing out clears the session cookie', async () => {
    const res = await post('/api/signout', { email: PEOPLE.alex });
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`${SESSION_COOKIE}=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)`, 'i'));
  });

  it('shows the owner a link to the owner area, and others not', async () => {
    expect(await (await get('/', OWNER)).text()).toContain('<a href="/owner">Owner area</a>');
    expect(await (await get('/', PEOPLE.alex)).text()).not.toContain('href="/owner"');
  });
});

describe('pages for signed-in people', () => {
  const idOf = async (googleResponseId: string) => (await pool.query('SELECT id FROM submissions WHERE google_response_id = $1', [googleResponseId])).rows[0].id as string;
  const text = async (path: string, email?: string) => (await get(path, email)).text();

  it('shows a signed-out visitor only the sign-in page, with no form names', async () => {
    const html = await text('/');
    expect(html).toContain('form-board');
    for (const leak of ['Community Project Ideas', 'Volunteer Sign-up', 'Help Requests', 'Event Feedback']) expect(html).not.toContain(leak);
  });

  it('lists Alex\'s own three submissions, newest first, and the open forms Alex hasn\'t sent', async () => {
    const html = await text('/', PEOPLE.alex);
    const mine = html.slice(html.indexOf('My submissions'));
    const titles = [...mine.matchAll(/<span class="title">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(titles).toEqual(['Community Project Ideas', 'Community Project Ideas', 'Help Requests']);
    const open = html.slice(html.indexOf('Open forms'), html.indexOf('My submissions'));
    // Ideas is sent, Help is closed; Event Feedback stays open because the entry with Alex's typed email isn't Alex's.
    expect([...open.matchAll(/<span class="title">([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(['Event Feedback', 'Volunteer Sign-up']);
    expect(open).toContain('href="https://docs.google.com/forms/d/e/fake-form-volunteer/viewform"');
  });

  it('never puts another person\'s email or answers in Alex\'s page source', async () => {
    const html = await text('/', PEOPLE.alex) + (await text(`/submissions/${await idOf('ideas-resp-001')}`, PEOPLE.alex));
    for (const other of [PEOPLE.sam, PEOPLE.jordan, PEOPLE.taylor, PEOPLE.morgan, 'Written by someone pretending to be Alex']) expect(html).not.toContain(other);
  });

  it('shows Jo, who sent nothing, all three open forms and an empty list', async () => {
    const html = await text('/', PEOPLE.jo);
    expect(html).toContain('You haven’t sent any of these forms yet');
    expect([...html.matchAll(/<span class="title">([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(['Community Project Ideas', 'Event Feedback', 'Volunteer Sign-up']);
  });

  it('shows a person their own submission, read-only, with answers as plain text', async () => {
    const res = await get(`/submissions/${await idOf('ideas-resp-001')}`, PEOPLE.alex);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; Community garden');
    expect(html).toContain('can’t be changed here');
    expect(html).not.toMatch(/<form[^>]*action="\/api\/owner/);
  });

  it('answers 404 for someone else\'s submission, the same as for one that doesn\'t exist', async () => {
    const sams = await get(`/submissions/${await idOf('vol-resp-001')}`, PEOPLE.alex);
    const missing = await get('/submissions/999999', PEOPLE.alex);
    expect(sams.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await sams.text()).not.toContain('Volunteer Sign-up');
  });

  it('answers 401 for a submission page when signed out', async () => {
    expect((await get(`/submissions/${await idOf('ideas-resp-001')}`)).status).toBe(401);
  });

  it('hides a submission from its sender once the owner deletes it', async () => {
    const id = await idOf('ideas-resp-001');
    await post(`/api/owner/submissions/${id}/delete`, { email: OWNER });
    expect((await get(`/submissions/${id}`, PEOPLE.alex)).status).toBe(404);
    expect(await text('/', PEOPLE.alex)).not.toContain(`/submissions/${id}"`);
  });

  it('moves a form out of "Open forms" when it closes', async () => {
    await pool.query("UPDATE forms SET accepting_responses = false WHERE google_form_id = 'fake-form-volunteer'");
    const html = await text('/', PEOPLE.jo);
    expect(html).not.toContain('Volunteer Sign-up');
  });
});

describe("the owner's home page", () => {
  beforeEach(() => pool.query('TRUNCATE applications, mail_scans RESTART IDENTITY'));

  const SENT_LINK = 'https://docs.google.com/forms/d/e/1FAIpQLSfSENTFORM0123456789/viewform?edit2=2_ABaOnuc';
  const SEEN_LINK = 'https://docs.google.com/forms/d/e/1FAIpQLSfSEENFORM0123456789/viewform';
  const apply = (title: string, link: string, status: 'found' | 'submitted', id: string, at = '2026-09-03T10:00:00Z') =>
    pool.query(
      `INSERT INTO applications (person_email, form_id, form_id_kind, link, title, applied_at, gmail_message_id, status)
       VALUES ($1, $2, 'published', $3, $4, $5, $2, $6)`,
      [OWNER, id, link, title, at, status],
    );
  const section = (html: string, heading: string, next?: string) => html.slice(html.indexOf(heading), next ? html.indexOf(next) : undefined);

  it('puts the forms the owner made beside the forms they applied to', async () => {
    const html = await (await get('/', OWNER)).text();
    expect(html).toContain('Forms you made');
    expect(html).toContain('Forms you applied to');
    expect(html).toMatch(/<div class="split">/);
  });

  it('lists the forms they made, open ones first, with how many responses each has', async () => {
    const made = section(await (await get('/', OWNER)).text(), 'Forms you made', 'Forms you applied to');
    const titles = [...made.matchAll(/<span class="title">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(titles).toEqual(['Community Project Ideas', 'Event Feedback', 'Volunteer Sign-up', 'Help Requests']);
    expect(made).toContain('>24 responses<');
    expect(made).toContain('>Closed<');
  });

  it('warns about a form that does not collect verified emails, and only that one', async () => {
    const made = section(await (await get('/', OWNER)).text(), 'Forms you made', 'Forms you applied to');
    expect(made.match(/Not collecting verified emails/g)).toHaveLength(1);
    const feedback = made.slice(made.indexOf('Event Feedback'), made.indexOf('Volunteer Sign-up'));
    expect(feedback).toContain('Not collecting verified emails');
  });

  it("says plainly when the owner's inbox has not been read yet", async () => {
    const applied = section(await (await get('/', OWNER)).text(), 'Forms you applied to');
    expect(applied).toContain('hasn’t been read yet');
  });

  it('lists what was found in the inbox, sent ones marked as such, with a link back to the response', async () => {
    await apply('Graduate scheme 2026', SENT_LINK, 'submitted', 'sent');
    await apply('Volunteer weekend', SEEN_LINK, 'found', 'seen', '2026-09-01T10:00:00Z');
    await pool.query("INSERT INTO mail_scans (person_email, read_through) VALUES ($1, '2026-09-05T00:00:00Z')", [OWNER]);
    const applied = section(await (await get('/', OWNER)).text(), 'Forms you applied to');
    expect(applied).toContain(`Inbox read up to ${showDate(new Date('2026-09-05T00:00:00Z'))}.`);
    const items = [...applied.matchAll(/<li class="item">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('Graduate scheme 2026');
    expect(items[0]).toContain('>Submitted<');
    expect(items[0]).toContain(`href="${SENT_LINK}"`);
    expect(items[0]).toContain('>Your response<');
    expect(items[1]).toContain('>Received<');
    expect(items[1]).toContain('>Open form<');
  });

  it('never turns a link that is not on Google Forms into something clickable', async () => {
    await apply('Looks like a form', 'javascript:alert(document.cookie)', 'found', 'bad1');
    await apply('Look-alike host', 'https://docs.google.com.evil.example/forms/d/e/x/viewform', 'found', 'bad2');
    const applied = section(await (await get('/', OWNER)).text(), 'Forms you applied to');
    expect(applied).toContain('Looks like a form');
    expect(applied).not.toContain('javascript:');
    expect(applied).not.toContain('evil.example');
  });

  it('shows an email subject as text, never as HTML', async () => {
    await apply('<script>alert("x")</script> Apply now', SEEN_LINK, 'found', 'xss');
    const html = await (await get('/', OWNER)).text();
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Apply now');
    expect(html).not.toContain('<script>alert("x")</script>');
  });

  it("never shows anybody else what is in the owner's inbox", async () => {
    await apply('Graduate scheme 2026', SENT_LINK, 'submitted', 'sent');
    const html = await (await get('/', PEOPLE.alex)).text();
    expect(html).not.toContain('Forms you applied to');
    expect(html).not.toContain('Graduate scheme 2026');
    expect(html).not.toContain('1FAIpQLSfSENTFORM');
    // Everyone else still gets the page they always had.
    expect(html).toContain('Open forms');
    expect(html).toContain('My submissions');
  });
});
