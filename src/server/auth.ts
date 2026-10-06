import { cookies } from 'next/headers';
import { forbidden, unauthorized } from 'next/navigation';
import { isOwner, isSameOrigin } from '../lib/access.ts';
import { readSessionValue, SESSION_COOKIE } from '../lib/session.ts';

/** The signed-in email from the session cookie, or null. */
export async function currentEmail(): Promise<string | null> {
  return readSessionValue((await cookies()).get(SESSION_COOKIE)?.value);
}

/** For owner pages: 401 page when signed out, 403 page when signed in as someone else. */
export async function requireOwnerPage(): Promise<string> {
  const email = await currentEmail();
  if (!email) unauthorized();
  if (!isOwner(email)) forbidden();
  return email;
}

/** For owner actions (form posts): a 401/403 response to return, or null when allowed. */
export async function ownerActionRefusal(req: Request): Promise<Response | null> {
  const email = await currentEmail();
  if (!email) return new Response('Sign in first.', { status: 401 });
  if (!isOwner(email)) return new Response('Only the owner can do this.', { status: 403 });
  if (!isSameOrigin(req)) return new Response('This request came from another site.', { status: 403 });
  return null;
}

/** 303 redirect back into the site after a form post. */
export const seeOther = (req: Request, path: string) => Response.redirect(new URL(path, req.url), 303);
