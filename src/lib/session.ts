import { createHmac, timingSafeEqual } from 'node:crypto';

// A signed cookie holding the signed-in email and an expiry. Signed with SESSION_SECRET (HMAC-SHA256),
// so it can't be forged or edited without the secret. Google sign-in (go-live) and the test switch
// both end by calling createSessionValue.

export const SESSION_COOKIE = 'fb_session';
export const SESSION_DAYS = 7;

function secret(): Buffer {
  const s = process.env.SESSION_SECRET ?? '';
  if (s.length < 32) throw new Error('SESSION_SECRET must be set to at least 32 random characters');
  return Buffer.from(s);
}

const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

export function createSessionValue(email: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ e: email.toLowerCase(), x: now + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** The signed-in email, or null if the value is missing, tampered with, malformed or expired. */
export function readSessionValue(value: string | undefined, now = Date.now()): string | null {
  if (!value) return null;
  const [payload, mac, extra] = value.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof e !== 'string' || !e.includes('@') || typeof x !== 'number' || x <= now) return null;
    return e;
  } catch {
    return null;
  }
}

/** Cookie attributes: not readable by page scripts, HTTPS-only outside development, not sent on cross-site posts. */
export function sessionCookieOptions() {
  return { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/', maxAge: SESSION_DAYS * 86400 };
}

// The sign-in-in-progress cookie: holds the `state` and `nonce` of one trip to Google, so the
// callback can tell its own sign-in from one started by somebody else. Signed like the session, so
// a planted cookie can't name a state the planter already knows.

export const SIGNIN_COOKIE = 'fb_signin';
export const SIGNIN_MINUTES = 10;

export function createSignInValue(state: string, nonce: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ s: state, n: nonce, x: now + SIGNIN_MINUTES * 60_000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** The state and nonce of the sign-in under way, or null if missing, tampered with or stale. */
export function readSignInValue(value: string | undefined, now = Date.now()): { state: string; nonce: string } | null {
  if (!value) return null;
  const [payload, mac, extra] = value.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { s, n, x } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof s !== 'string' || !s || typeof n !== 'string' || !n || typeof x !== 'number' || x <= now) return null;
    return { state: s, nonce: n };
  } catch {
    return null;
  }
}

/**
 * Like the session cookie but short-lived. SameSite stays "lax" so the browser still sends it when
 * Google sends the person back by a top-level link; "strict" would withhold it and break sign-in.
 */
export function signInCookieOptions() {
  return { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/', maxAge: SIGNIN_MINUTES * 60 };
}
