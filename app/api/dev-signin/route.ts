import { cookies } from 'next/headers';
import { devSignInEnabled, isSameOrigin } from '../../../src/lib/access.ts';
import { createSessionValue, SESSION_COOKIE, sessionCookieOptions } from '../../../src/lib/session.ts';
import { seeOther } from '../../../src/server/auth.ts';

/** Test-person sign-in for development. Answers 404 unless DEV_SIGNIN=1, and always in production. */
export async function POST(req: Request) {
  if (!devSignInEnabled()) return new Response('Not found', { status: 404 });
  if (!isSameOrigin(req)) return new Response('This request came from another site.', { status: 403 });
  const email = String((await req.formData()).get('email') ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return new Response('Choose a test person.', { status: 400 });
  (await cookies()).set(SESSION_COOKIE, createSessionValue(email), sessionCookieOptions());
  return seeOther(req, '/');
}
