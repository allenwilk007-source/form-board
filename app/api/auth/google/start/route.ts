import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { isSameOrigin } from '../../../../../src/lib/access.ts';
import { googleSignInFromEnv } from '../../../../../src/lib/google-signin.ts';
import { createSignInValue, SIGNIN_COOKIE, signInCookieOptions } from '../../../../../src/lib/session.ts';

/** Starts sign-in: remembers this attempt in a short-lived cookie, then sends the person to Google. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return new Response('This request came from another site.', { status: 403 });
  const signIn = googleSignInFromEnv();
  if (!signIn) return new Response('Google sign-in is not set up on this site.', { status: 503 });

  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  (await cookies()).set(SIGNIN_COOKIE, createSignInValue(state, nonce), signInCookieOptions());
  return Response.redirect(signIn.authUrl({ state, nonce }), 303);
}
