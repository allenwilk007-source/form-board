/** Owner emails from OWNER_EMAILS (comma-separated). Compared in lower case. */
export function ownerEmails(): string[] {
  return (process.env.OWNER_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export function isOwner(email: string | null): boolean {
  return email !== null && ownerEmails().includes(email.toLowerCase());
}

/** The test-person switch: only when DEV_SIGNIN=1, and never in production, whatever DEV_SIGNIN says. */
export function devSignInEnabled(): boolean {
  return process.env.DEV_SIGNIN === '1' && process.env.NODE_ENV !== 'production';
}

/**
 * Refuses a form post that comes from another site. The session cookie is SameSite=Lax, which already
 * stops most of these; this is a second check. Browsers send Origin on every POST.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
