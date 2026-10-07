// The real Google source: reads the owner's forms with their saved Google approval (an OAuth refresh
// token). Read-only scopes only. Tokens never appear in errors or logs.
import { isAcceptingResponses, type GoogleForm, type GoogleResponse } from './google.ts';
import type { FormsSource } from './sync.ts';

/** The read-only permissions the owner approves once. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.metadata.readonly', // list the owner's forms (names and dates, not contents)
  'https://www.googleapis.com/auth/forms.body.readonly', // read each form's questions and settings
  'https://www.googleapis.com/auth/forms.responses.readonly', // read the responses
];

/**
 * How far back closed forms stay listed: a form changed (in Google Drive's sense) within this many
 * days is listed whatever its state. A form still accepting responses is listed however old it is,
 * so this window only decides how long a form lingers after it closes.
 */
export const FORM_WINDOW_DAYS = 60;

type Options = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
  now?: () => number;
};

export function createGoogleSource(opts: Options): FormsSource {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let token: { value: string; expires: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expires > now() + 60_000) return token.value;
    const res = await doFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: opts.clientId, client_secret: opts.clientSecret, refresh_token: opts.refreshToken, grant_type: 'refresh_token' }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      const why = body.error === 'invalid_grant'
        ? 'Google no longer accepts the saved approval (it expired or was revoked). Reconnect Google in the owner area.'
        : `${body.error ?? res.status}${body.error_description ? `: ${body.error_description}` : ''}`;
      throw new Error(`Google sign-in for sync failed: ${why}`);
    }
    token = { value: body.access_token, expires: now() + (body.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  async function get<T>(url: string): Promise<T> {
    const res = await doFetch(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
      throw new Error(`Google API ${res.status} for ${new URL(url).pathname}: ${body.error?.message ?? body.error?.status ?? res.statusText}`.slice(0, 500));
    }
    return (await res.json()) as T;
  }

  const getForm = (id: string) => get<GoogleForm>(`https://forms.googleapis.com/v1/forms/${encodeURIComponent(id)}`);

  return {
    /**
     * Every form the owner owns that is either still accepting responses, whatever its age, or was
     * changed in the last FORM_WINDOW_DAYS days. Drive cannot say whether a form is open — that
     * lives in the Forms API — so forms older than the window are read individually to find out.
     */
    async listForms() {
      const since = now() - FORM_WINDOW_DAYS * 864e5;
      const q = `mimeType = 'application/vnd.google-apps.form' and 'me' in owners and trashed = false`;
      const files: { id: string; modifiedTime?: string }[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ q, fields: 'nextPageToken, files(id,modifiedTime)', pageSize: '100', orderBy: 'modifiedTime desc' });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await get<{ files?: { id: string; modifiedTime?: string }[]; nextPageToken?: string }>(`https://www.googleapis.com/drive/v3/files?${params}`);
        files.push(...(page.files ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);

      const ids: string[] = [];
      for (const f of files) {
        // A missing or unparseable date counts as old, so the question falls to "is it open?".
        if (Date.parse(f.modifiedTime ?? '') > since) {
          ids.push(f.id);
          continue;
        }
        try {
          if (isAcceptingResponses(await getForm(f.id))) ids.push(f.id);
        } catch {
          // Listed anyway: a form we cannot read should fail loudly in the sync log rather than
          // disappear from the site as though the owner had deleted it.
          ids.push(f.id);
        }
      }
      return ids;
    },

    getForm,

    async listResponses(id) {
      const all: GoogleResponse[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ pageSize: '5000' });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await get<{ responses?: GoogleResponse[]; nextPageToken?: string }>(
          `https://forms.googleapis.com/v1/forms/${encodeURIComponent(id)}/responses?${params}`,
        );
        all.push(...(page.responses ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return all;
    },
  };
}

/** The source from environment variables, or null when they aren't all set. */
export function googleSourceFromEnv(): FormsSource | null {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: refreshToken } = process.env;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return createGoogleSource({ clientId, clientSecret, refreshToken });
}
