// Google sign-in, against a pretend Google: a locally generated key pair stands in for Google's
// signing keys, so these tests mint the ID tokens a real sign-in would receive — valid ones and
// every shape of bad one.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createGoogleSignIn, ISSUERS, sameSecret, SIGNIN_SCOPES } from '../src/lib/google-signin.ts';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const REDIRECT = 'http://localhost:3000/api/auth/google/callback';
const NONCE = 'nonce-abcdefghijklmnop';

let signKey: CryptoKey;
let keys: JWTVerifyGetKey;
/** The same key pair, but presented as somebody else's, for the "signed by a stranger" test. */
let strangerKey: CryptoKey;

beforeAll(async () => {
  const google = await generateKeyPair('RS256', { extractable: true });
  signKey = google.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(google.publicKey)), kid: 'g1', alg: 'RS256' }] });
  strangerKey = (await generateKeyPair('RS256', { extractable: true })).privateKey;
});

type Claims = { aud?: string; iss?: string; email?: string; email_verified?: boolean; nonce?: string; exp?: string | number };

async function idToken(claims: Claims = {}, key?: CryptoKey) {
  const { aud = CLIENT_ID, iss = ISSUERS[0], email = 'Alex.Kim@Example.org', email_verified = true, nonce = NONCE, exp = '1h' } = claims;
  return new SignJWT({ email, email_verified, nonce })
    .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key ?? signKey);
}

/** A pretend token endpoint. Records what it was sent. */
function fakeGoogle(reply: (body: URLSearchParams) => { status?: number; body: unknown }) {
  const calls: URLSearchParams[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(TOKEN_ENDPOINT);
    const sent = new URLSearchParams(String(init?.body));
    calls.push(sent);
    const { status = 200, body } = reply(sent);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const signIn = (fetch: typeof globalThis.fetch) =>
  createGoogleSignIn({ clientId: CLIENT_ID, clientSecret: 'secret-xyz', redirectUri: REDIRECT, fetch, keys });

describe('authUrl', () => {
  const url = () => new URL(signIn(fakeGoogle(() => ({ body: {} })).fetch).authUrl({ state: 'st-1', nonce: 'no-1' }));

  it('asks Google only who the person is, never for their files', () => {
    expect(url().searchParams.get('scope')).toBe('openid email');
    expect(SIGNIN_SCOPES).toEqual(['openid', 'email']);
    // The owner's data scopes must never reach a visitor's consent screen.
    expect(url().toString()).not.toContain('drive');
    expect(url().toString()).not.toContain('forms');
  });

  it('sends the state, the nonce and the registered redirect URI', () => {
    const p = url().searchParams;
    expect(p.get('state')).toBe('st-1');
    expect(p.get('nonce')).toBe('no-1');
    expect(p.get('redirect_uri')).toBe(REDIRECT);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(CLIENT_ID);
  });

  it('goes to Google and never leaks the client secret', () => {
    expect(url().origin + url().pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url().toString()).not.toContain('secret-xyz');
  });
});

describe('emailFromCode', () => {
  it('exchanges the code and returns the verified email, lower-cased', async () => {
    const g = fakeGoogle(() => ({ body: { id_token: 'placeholder' } }));
    const token = await idToken();
    const g2 = fakeGoogle(() => ({ body: { id_token: token } }));
    expect(await signIn(g2.fetch).emailFromCode('code-1', NONCE)).toBe('alex.kim@example.org');
    expect(g.calls.length).toBe(0);
    expect(Object.fromEntries(g2.calls[0])).toEqual({
      code: 'code-1',
      client_id: CLIENT_ID,
      client_secret: 'secret-xyz',
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    });
  });

  it('accepts the bare issuer Google also uses', async () => {
    const token = await idToken({ iss: 'accounts.google.com' });
    const g = fakeGoogle(() => ({ body: { id_token: token } }));
    expect(await signIn(g.fetch).emailFromCode('c', NONCE)).toBe('alex.kim@example.org');
  });

  it('refuses a token minted for a different app', async () => {
    const token = await idToken({ aud: 'someone-else.apps.googleusercontent.com' });
    const g = fakeGoogle(() => ({ body: { id_token: token } }));
    await expect(signIn(g.fetch).emailFromCode('c', NONCE)).rejects.toThrow(/did not check out/);
  });

  it('refuses a token from a different issuer', async () => {
    const token = await idToken({ iss: 'https://evil.example' });
    const g = fakeGoogle(() => ({ body: { id_token: token } }));
    await expect(signIn(g.fetch).emailFromCode('c', NONCE)).rejects.toThrow(/did not check out/);
  });

  it('refuses a token signed by someone who is not Google', async () => {
    const token = await idToken({}, strangerKey);
    const g = fakeGoogle(() => ({ body: { id_token: token } }));
    await expect(signIn(g.fetch).emailFromCode('c', NONCE)).rejects.toThrow(/did not check out/);
  });

  it('refuses an expired token', async () => {
    const token = await idToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const g = fakeGoogle(() => ({ body: { id_token: token } }));
    await expect(signIn(g.fetch).emailFromCode('c', NONCE)).rejects.toThrow(/did not check out/);
  });

  it('refuses a token answering a different sign-in', async () => {
    const token = await idToken({ nonce: 'a-different-nonce-entirely' });
    const g = fakeGoogle(() => ({ body: { id_token: token } }));
    await expect(signIn(g.fetch).emailFromCode('c', NONCE)).rejects.toThrow(/different sign-in/);
  });

  it('refuses a token with no nonce at all', async () => {
    const token = await new SignJWT({ email: 'a@b.org', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
      .setIssuer(ISSUERS[0])
      .setAudience(CLIENT_ID)
      .setExpirationTime('1h')
      .sign(signKey);
    const g = fakeGoogle(() => ({ body: { id_token: token } }));
    await expect(signIn(g.fetch).emailFromCode('c', NONCE)).rejects.toThrow(/different sign-in/);
  });

  it('refuses an address Google has not verified', async () => {
    const token = await idToken({ email_verified: false });
    const g = fakeGoogle(() => ({ body: { id_token: token } }));
    await expect(signIn(g.fetch).emailFromCode('c', NONCE)).rejects.toThrow(/has not verified/);
  });

  it.each(['', 'not-an-email', 'two@at@signs', 'spaces in@it.org'])('refuses a token whose email is "%s"', async (email) => {
    const token = await idToken({ email });
    const g = fakeGoogle(() => ({ body: { id_token: token } }));
    await expect(signIn(g.fetch).emailFromCode('c', NONCE)).rejects.toThrow(/no usable email/);
  });

  it('refuses a token carrying no email claim at all', async () => {
    const token = await new SignJWT({ email_verified: true, nonce: NONCE })
      .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
      .setIssuer(ISSUERS[0])
      .setAudience(CLIENT_ID)
      .setExpirationTime('1h')
      .sign(signKey);
    const g = fakeGoogle(() => ({ body: { id_token: token } }));
    await expect(signIn(g.fetch).emailFromCode('c', NONCE)).rejects.toThrow(/no usable email/);
  });

  it('explains a refusal from the token endpoint without echoing the code', async () => {
    const g = fakeGoogle(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Code was already redeemed' } }));
    await expect(signIn(g.fetch).emailFromCode('secret-code-xyz', NONCE)).rejects.toThrow(/invalid_grant: Code was already redeemed/);
    await expect(signIn(g.fetch).emailFromCode('secret-code-xyz', NONCE)).rejects.not.toThrow(/secret-code-xyz/);
  });

  it('copes with a token endpoint that answers with no token and no JSON', async () => {
    const g = fakeGoogle(() => ({ status: 500, body: 'nonsense' }));
    await expect(signIn(g.fetch).emailFromCode('c', NONCE)).rejects.toThrow(/Google sign-in failed/);
  });
});

describe('sameSecret', () => {
  it('matches only an exact pair', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
    expect(sameSecret('', '')).toBe(true);
    expect(sameSecret('abc', '')).toBe(false);
  });
});
