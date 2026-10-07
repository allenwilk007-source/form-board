// Turning a saved Google approval (a refresh token) into short-lived access tokens. Shared by
// everything that reads Google as the owner: their forms, and their mail. Tokens and the client
// secret never appear in an error or a log.

export type TokenOptions = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
  now?: () => number;
};

/** An access token for the saved approval, fetched when the last one is close to running out. */
export function createTokenSource(opts: TokenOptions): () => Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let token: { value: string; expires: number } | null = null;

  return async function accessToken(): Promise<string> {
    if (token && token.expires > now() + 60_000) return token.value;
    const res = await doFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: opts.clientId, client_secret: opts.clientSecret, refresh_token: opts.refreshToken, grant_type: 'refresh_token' }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      const why =
        body.error === 'invalid_grant'
          ? 'Google no longer accepts the saved approval (it expired or was revoked). Reconnect Google in the owner area.'
          : `${body.error ?? res.status}${body.error_description ? `: ${body.error_description}` : ''}`;
      throw new Error(`Google sign-in for sync failed: ${why}`);
    }
    token = { value: body.access_token, expires: now() + (body.expires_in ?? 3600) * 1000 };
    return token.value;
  };
}

/** A JSON GET against a Google API with the owner's approval. Throws with the API's own complaint. */
export function createGet(accessToken: () => Promise<string>, doFetch: typeof fetch) {
  return async function get<T>(url: string): Promise<T> {
    const res = await doFetch(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
      throw new Error(`Google API ${res.status} for ${new URL(url).pathname}: ${body.error?.message ?? body.error?.status ?? res.statusText}`.slice(0, 500));
    }
    return (await res.json()) as T;
  };
}
