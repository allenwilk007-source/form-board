import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devSignInEnabled, isOwner, isSameOrigin } from '../src/lib/access.ts';
import { createSessionValue, readSessionValue, SESSION_DAYS } from '../src/lib/session.ts';

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
