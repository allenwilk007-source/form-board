import { cookies } from 'next/headers';
import { googleSignInFromEnv, sameSecret } from '../../../../../src/lib/google-signin.ts';
import { createSessionValue, readSignInValue, SESSION_COOKIE, sessionCookieOptions, SIGNIN_COOKIE } from '../../../../../src/lib/session.ts';
import { seeOther } from '../../../../../src/server/auth.ts';

/**
 * Where Google sends the person back. Google arrives by a top-level link, so there is no Origin
 * header to check: the `state` in the sign-in cookie is what proves this answers a sign-in started
 * here, and it is good for one use only, whatever the outcome.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const jar = await cookies();
  const started = readSignInValue(jar.get(SIGNIN_COOKIE)?.value);
  jar.delete(SIGNIN_COOKIE);

  // The person pressed Cancel, or Google refused. Not an error: back to the sign-in page.
  if (url.searchParams.get('error')) return seeOther(req, '/?signin=denied');
  if (!started) return new Response('That sign-in took too long, or did not start here. Try again.', { status: 403 });

  const state = url.searchParams.get('state');
  if (!state || !sameSecret(state, started.state)) return new Response('That sign-in did not start here.', { status: 403 });

  const code = url.searchParams.get('code');
  if (!code) return new Response('Google sent no sign-in code.', { status: 403 });

  const signIn = googleSignInFromEnv();
  if (!signIn) return new Response('Google sign-in is not set up on this site.', { status: 503 });

  let email: string;
  try {
    email = await signIn.emailFromCode(code, started.nonce);
  } catch (err) {
    // The reason names Google's complaint, never the code or the token.
    console.error((err as Error).message);
    return seeOther(req, '/?signin=failed');
  }

  jar.set(SESSION_COOKIE, createSessionValue(email), sessionCookieOptions());
  return seeOther(req, '/');
}
