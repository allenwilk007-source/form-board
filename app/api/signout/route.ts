import { cookies } from 'next/headers';
import { isSameOrigin } from '../../../src/lib/access.ts';
import { SESSION_COOKIE } from '../../../src/lib/session.ts';
import { seeOther } from '../../../src/server/auth.ts';

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return new Response('This request came from another site.', { status: 403 });
  (await cookies()).delete(SESSION_COOKIE);
  return seeOther(req, '/');
}
