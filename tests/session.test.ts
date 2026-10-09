import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devSignInEnabled, googleSignInEnabled, isOwner, isSameOrigin } from '../src/lib/access.ts';
import {
  createSessionValue,
  createSignInValue,
  readSessionValue,
  readSignInValue,
  SESSION_COOKIE,
  SESSION_DAYS,
  SIGNIN_COOKIE,
  SIGNIN_MINUTES,
  signInCookieOptions,
} from '../src/lib/session.ts';

const saved = { ...process.env };
beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-that-is-at-least-32-characters-long';
});
afterEach(() => {
  process.env = { ...saved };
});

describe('session cookie', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');

  it('round-trips the email, lower-cased', () => {
    expect(readSessionValue(createSessionValue('Alex.Kim@Example.org', now), now)).toBe('alex.kim@example.org');
  });

  it('expires after the session length', () => {
    const v = createSessionValue('a@example.org', now);
    expect(readSessionValue(v, now + SESSION_DAYS * 864e5 - 1000)).toBe('a@example.org');
    expect(readSessionValue(v, now + SESSION_DAYS * 864e5)).toBeNull();
  });

  it('rejects an edited email, even keeping the old signature', () => {
    const [, mac] = createSessionValue('a@example.org', now).split('.');
    const forged = Buffer.from(JSON.stringify({ e: 'owner@example.org', x: now + 1e9 })).toString('base64url');
    expect(readSessionValue(`${forged}.${mac}`, now)).toBeNull();
  });

  it('rejects a value signed with a different secret', () => {
    const v = createSessionValue('a@example.org', now);
    process.env.SESSION_SECRET = 'another-secret-that-is-also-32-characters-plus';
    expect(readSessionValue(v, now)).toBeNull();
  });

  it.each([undefined, '', 'abc', 'a.b', 'a.b.c', '..', `${Buffer.from('not json').toString('base64url')}.x`])('rejects junk: %s', (v) => {
    expect(readSessionValue(v, now)).toBeNull();
  });

  it('refuses to work without a long enough secret', () => {
    process.env.SESSION_SECRET = 'short';
    expect(() => createSessionValue('a@example.org', now)).toThrow(/SESSION_SECRET/);
    delete process.env.SESSION_SECRET;
    expect(() => readSessionValue('x.y', now)).toThrow(/SESSION_SECRET/);
  });
});

describe('sign-in-in-progress cookie', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');

  it('round-trips the state and nonce', () => {
    expect(readSignInValue(createSignInValue('st-1', 'no-1', now), now)).toEqual({ state: 'st-1', nonce: 'no-1' });
  });

  it('goes stale, so an abandoned sign-in cannot be finished later', () => {
    const v = createSignInValue('st-1', 'no-1', now);
    expect(readSignInValue(v, now + SIGNIN_MINUTES * 60_000 - 1000)).not.toBeNull();
    expect(readSignInValue(v, now + SIGNIN_MINUTES * 60_000)).toBeNull();
  });

  it('rejects a planted state, even keeping a real signature', () => {
    const [, mac] = createSignInValue('st-1', 'no-1', now).split('.');
    const forged = Buffer.from(JSON.stringify({ s: 'attacker-state', n: 'attacker-nonce', x: now + 1e9 })).toString('base64url');
    expect(readSignInValue(`${forged}.${mac}`, now)).toBeNull();
  });

  it('rejects a value signed with a different secret', () => {
    const v = createSignInValue('st-1', 'no-1', now);
    process.env.SESSION_SECRET = 'another-secret-that-is-also-32-characters-plus';
    expect(readSignInValue(v, now)).toBeNull();
  });

  it.each([undefined, '', 'abc', 'a.b', 'a.b.c', `${Buffer.from('not json').toString('base64url')}.x`])('rejects junk: %s', (v) => {
    expect(readSignInValue(v, now)).toBeNull();
  });

  // Signed with the real secret, so the contents are the only thing that can fail these.
  const properlySigned = (claims: object) => {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const mac = createHmac('sha256', Buffer.from(process.env.SESSION_SECRET!)).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  };

  it('accepts its own properly-signed value, so the next tests fail on contents alone', () => {
    expect(readSignInValue(properlySigned({ s: 'st-1', n: 'no-1', x: now + 1e9 }), now)).toEqual({ state: 'st-1', nonce: 'no-1' });
  });

  it.each([{ n: 'no-1' }, { s: 'st-1' }, { s: '', n: 'no-1' }, { s: 'st-1', n: '' }, { s: 1, n: 2 }])('rejects a half-filled payload: %j', (claims) => {
    expect(readSignInValue(properlySigned({ ...claims, x: now + 1e9 }), now)).toBeNull();
  });

  it('is a different cookie from the session', () => {
    expect(SIGNIN_COOKIE).not.toBe(SESSION_COOKIE);
  });

  it('stays readable across a top-level redirect back from Google', () => {
    expect(signInCookieOptions().sameSite).toBe('lax');
    expect(signInCookieOptions().httpOnly).toBe(true);
  });
});

describe('owner check', () => {
  it('matches OWNER_EMAILS ignoring case and spaces', () => {
    process.env.OWNER_EMAILS = ' Allenwilk007@gmail.com , second@example.org';
    expect(isOwner('allenwilk007@gmail.com')).toBe(true);
    expect(isOwner('SECOND@example.org')).toBe(true);
    expect(isOwner('alex.kim@example.org')).toBe(false);
    expect(isOwner(null)).toBe(false);
  });

  it('makes nobody the owner when OWNER_EMAILS is empty or missing', () => {
    process.env.OWNER_EMAILS = '';
    expect(isOwner('allenwilk007@gmail.com')).toBe(false);
    delete process.env.OWNER_EMAILS;
    expect(isOwner('')).toBe(false);
  });
});

describe('test-person switch', () => {
  it('is on only with DEV_SIGNIN=1 outside production', () => {
    process.env.DEV_SIGNIN = '1';
    (process.env as Record<string, string>).NODE_ENV = 'development';
    expect(devSignInEnabled()).toBe(true);
    (process.env as Record<string, string>).NODE_ENV = 'production';
    expect(devSignInEnabled()).toBe(false);
    (process.env as Record<string, string>).NODE_ENV = 'development';
    process.env.DEV_SIGNIN = 'true';
    expect(devSignInEnabled()).toBe(false);
  });
});

describe('Google sign-in switch', () => {
  const vars = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const;
  const setAll = () => {
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/auth/google/callback';
  };

  it('is on only when the client, its secret and the redirect URI are all set', () => {
    setAll();
    expect(googleSignInEnabled()).toBe(true);
  });

  it.each(vars)('is off without %s', (missing) => {
    setAll();
    delete process.env[missing];
    expect(googleSignInEnabled()).toBe(false);
  });

  it('is off when a variable is set to an empty string', () => {
    setAll();
    process.env.GOOGLE_REDIRECT_URI = '';
    expect(googleSignInEnabled()).toBe(false);
  });

  it('does not depend on the refresh token, which is the owner\'s, not a visitor\'s', () => {
    setAll();
    delete process.env.GOOGLE_REFRESH_TOKEN;
    expect(googleSignInEnabled()).toBe(true);
  });
});

describe('same-origin check for form posts', () => {
  const req = (headers: Record<string, string>) => new Request('http://localhost:3000/api/x', { method: 'POST', headers });
  it('accepts a post from the site itself', () => {
    expect(isSameOrigin(req({ origin: 'http://localhost:3000', host: 'localhost:3000' }))).toBe(true);
  });
  it.each([
    [{ origin: 'https://evil.example', host: 'localhost:3000' }],
    [{ host: 'localhost:3000' }],
    [{ origin: 'null', host: 'localhost:3000' }],
  ])('refuses %j', (headers) => {
    expect(isSameOrigin(req(headers))).toBe(false);
  });
});
