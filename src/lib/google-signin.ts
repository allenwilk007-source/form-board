// Google sign-in for visitors: proves who someone is, and nothing more. Separate from the owner's
// data approval in google-api.ts, which reads the owner's forms — a visitor is only ever asked for
// their identity, never for access to their Drive or Forms. Codes, tokens and the client secret
// never appear in errors or logs.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { timingSafeEqual } from 'node:crypto';
import { googleSignInEnabled } from './access.ts';

/** The only permissions a visitor approves: who they are, and their email address. */
export const SIGNIN_SCOPES = ['openid', 'email'];

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Google signs ID tokens as either of these. Both are listed in its OpenID configuration. */
export const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** Google's signing keys, fetched and cached by jose. One set for the whole server process. */
let sharedKeys: JWTVerifyGetKey | undefined;
const googleKeys = () => (sharedKeys ??= createRemoteJWKSet(new URL(CERTS_URL)));

type Options = {
  clientId: string;
  clientSecret: string;
  /** Must match a redirect URI registered on the Google client, character for character. */
  redirectUri: string;
  fetch?: typeof fetch;
  /** Google's signing keys. Tests pass a local set. */
  keys?: JWTVerifyGetKey;
};

export type GoogleSignIn = {
  /** Where to send someone to approve. `state` guards the callback; `nonce` ties the token to it. */
  authUrl(args: { state: string; nonce: string }): string;
  /** The verified, lower-cased email behind one authorization code, or a throw explaining why not. */
  emailFromCode(code: string, nonce: string): Promise<string>;
};

export function createGoogleSignIn(opts: Options): GoogleSignIn {
  const doFetch = opts.fetch ?? fetch;
  const keys = opts.keys ?? googleKeys();

  return {
    authUrl({ state, nonce }) {
      const params = new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        scope: SIGNIN_SCOPES.join(' '),
        state,
        nonce,
        // Ask every time rather than reusing a silent session, so signing out means something.
        prompt: 'select_account',
      });
      return `${AUTH_ENDPOINT}?${params}`;
    },

    async emailFromCode(code, nonce) {
      const res = await doFetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          redirect_uri: opts.redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
      if (!res.ok || !body.id_token) {
        throw new Error(`Google sign-in failed: ${body.error ?? res.status}${body.error_description ? `: ${body.error_description}` : ''}`.slice(0, 300));
      }
      return emailFromIdToken(body.id_token, { keys, audience: opts.clientId, nonce });
    },
  };
}

/**
 * The email from one ID token, once Google's signature, issuer, audience and expiry all check out.
 * `audience` is the check that stops a token minted for a different app being handed to this one.
 */
export async function emailFromIdToken(
  idToken: string,
  { keys, audience, nonce }: { keys: JWTVerifyGetKey; audience: string; nonce: string },
): Promise<string> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keys, { issuer: ISSUERS, audience, clockTolerance: 60 }));
  } catch (err) {
    throw new Error(`Google sign-in failed: the token did not check out (${(err as Error).message})`.slice(0, 300));
  }
  if (typeof payload.nonce !== 'string' || !sameSecret(payload.nonce, nonce)) {
    throw new Error('Google sign-in failed: the token answers a different sign-in.');
  }
  // Google sets this false for an address it has not confirmed belongs to the account.
  if (payload.email_verified !== true) throw new Error('Google sign-in failed: Google has not verified that address.');
  const email = payload.email;
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('Google sign-in failed: no usable email address in the token.');
  return email.toLowerCase();
}

/** Compares two secrets without leaking how much of the start matched. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Sign-in from environment variables, or null when it isn't set up. */
export function googleSignInFromEnv(): GoogleSignIn | null {
  if (!googleSignInEnabled()) return null;
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REDIRECT_URI: redirectUri } = process.env;
  return createGoogleSignIn({ clientId: clientId!, clientSecret: clientSecret!, redirectUri: redirectUri! });
}
