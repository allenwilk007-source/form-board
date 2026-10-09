import { describe, expect, it } from 'vitest';
import { createGoogleSource, FORM_WINDOW_DAYS } from '../src/lib/google-api.ts';

const NOW = Date.parse('2026-10-06T12:00:00Z');
type Call = { url: string; init?: RequestInit };

/** A pretend Google: answers by URL, records every call. */
function fakeGoogle(routes: Record<string, (url: URL, call: number) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    const key = Object.keys(routes).find((k) => url.toString().startsWith(k));
    if (!key) return new Response('{}', { status: 404 });
    counts[key] = (counts[key] ?? 0) + 1;
    const { status = 200, body } = routes[key](url, counts[key]);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}
const TOKEN = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const FORMS = 'https://forms.googleapis.com/v1/forms/';
const okToken = () => ({ body: { access_token: 'access-123', expires_in: 3600 } });
const source = (fetch: typeof globalThis.fetch, now = () => NOW) =>
  createGoogleSource({ clientId: 'cid', clientSecret: 'secret-xyz', refreshToken: 'refresh-abc', fetch, now });

describe('listForms', () => {
  /** A Drive modifiedTime that many days before NOW. */
  const daysAgo = (n: number) => new Date(NOW - n * 864e5).toISOString();
  const recent = daysAgo(FORM_WINDOW_DAYS - 1);
  const old = daysAgo(FORM_WINDOW_DAYS + 1);
  const openForm = { body: { publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } } } };
  const closedForm = { body: { publishSettings: { publishState: { isPublished: true, isAcceptingResponses: false } } } };

  it('asks Drive for every form the owner owns and has not trashed, following every page', async () => {
    const g = fakeGoogle({
      [TOKEN]: okToken,
      [DRIVE]: (url) =>
        url.searchParams.get('pageToken')
          ? { body: { files: [{ id: 'f3', modifiedTime: recent }] } }
          : { body: { files: [{ id: 'f1', modifiedTime: recent }, { id: 'f2', modifiedTime: recent }], nextPageToken: 'p2' } },
    });
    expect(await source(g.fetch).listForms()).toEqual(['f1', 'f2', 'f3']);
    // No date in the query: an open form must be found however old it is, and Drive cannot say
    // whether a form is open, so the filtering happens here instead.
    const q = new URL(g.calls[1].url).searchParams.get('q')!;
    expect(q).toBe("mimeType = 'application/vnd.google-apps.form' and 'me' in owners and trashed = false");
    expect(q).not.toContain('modifiedTime');
    expect(new URL(g.calls[1].url).searchParams.get('fields')).toContain('modifiedTime');
    expect((g.calls[1].init?.headers as Record<string, string>).authorization).toBe('Bearer access-123');
  });

  it('lists a recently changed form without reading it, whether it is open or closed', async () => {
    const g = fakeGoogle({ [TOKEN]: okToken, [DRIVE]: () => ({ body: { files: [{ id: 'f1', modifiedTime: recent }] } }) });
    expect(await source(g.fetch).listForms()).toEqual(['f1']);
    // Only the token and Drive calls: the form itself is not fetched to decide this.
    expect(g.calls.filter((c) => c.url.startsWith(FORMS))).toEqual([]);
  });

  it('keeps an old form that is still accepting responses', async () => {
    const g = fakeGoogle({ [TOKEN]: okToken, [DRIVE]: () => ({ body: { files: [{ id: 'f1', modifiedTime: daysAgo(900) }] } }), [FORMS]: () => openForm });
    expect(await source(g.fetch).listForms()).toEqual(['f1']);
  });

  it('drops an old form that has closed', async () => {
    const g = fakeGoogle({ [TOKEN]: okToken, [DRIVE]: () => ({ body: { files: [{ id: 'f1', modifiedTime: old }] } }), [FORMS]: () => closedForm });
    expect(await source(g.fetch).listForms()).toEqual([]);
  });

  it('keeps an old form with no publish settings, which counts as open', async () => {
    const g = fakeGoogle({ [TOKEN]: okToken, [DRIVE]: () => ({ body: { files: [{ id: 'f1', modifiedTime: old }] } }), [FORMS]: () => ({ body: {} }) });
    expect(await source(g.fetch).listForms()).toEqual(['f1']);
  });

  it('treats a missing modifiedTime as old and falls back to asking whether the form is open', async () => {
    const g = fakeGoogle({ [TOKEN]: okToken, [DRIVE]: () => ({ body: { files: [{ id: 'f1' }] } }), [FORMS]: () => closedForm });
    expect(await source(g.fetch).listForms()).toEqual([]);
  });

  it('keeps an old form it cannot read, so the failure reaches the sync log instead of hiding it', async () => {
    const g = fakeGoogle({ [TOKEN]: okToken, [DRIVE]: () => ({ body: { files: [{ id: 'f1', modifiedTime: old }] } }), [FORMS]: () => ({ status: 500, body: {} }) });
    expect(await source(g.fetch).listForms()).toEqual(['f1']);
  });

  it('sorts out a mixed set: recent ones kept, old ones only while open', async () => {
    const forms: Record<string, { body: unknown }> = { 'old-open': openForm, 'old-shut': closedForm };
    const g = fakeGoogle({
      [TOKEN]: okToken,
      [DRIVE]: () => ({
        body: {
          files: [
            { id: 'new-shut', modifiedTime: recent },
            { id: 'old-open', modifiedTime: old },
            { id: 'old-shut', modifiedTime: old },
            { id: 'new-open', modifiedTime: daysAgo(0) },
          ],
        },
      }),
      [FORMS]: (url) => forms[decodeURIComponent(url.pathname.split('/').pop()!)] ?? closedForm,
    });
    expect(await source(g.fetch).listForms()).toEqual(['new-shut', 'old-open', 'new-open']);
  });
});

describe('listResponses', () => {
  it('follows every page of responses', async () => {
    const g = fakeGoogle({
      [TOKEN]: okToken,
      [FORMS]: (url) =>
        url.searchParams.get('pageToken')
          ? { body: { responses: [{ responseId: 'r3' }] } }
          : { body: { responses: [{ responseId: 'r1' }, { responseId: 'r2' }], nextPageToken: 'n' } },
    });
    expect((await source(g.fetch).listResponses('form 1')).map((r) => r.responseId)).toEqual(['r1', 'r2', 'r3']);
    expect(g.calls[1].url).toContain('/v1/forms/form%201/responses?pageSize=5000');
  });

  it('treats a form with no responses as an empty list', async () => {
    const g = fakeGoogle({ [TOKEN]: okToken, [FORMS]: () => ({ body: {} }) });
    expect(await source(g.fetch).listResponses('f')).toEqual([]);
  });
});

describe('access token', () => {
  it('reuses the token until a minute before it expires, then refreshes', async () => {
    let t = NOW;
    const g = fakeGoogle({ [TOKEN]: okToken, [FORMS]: () => ({ body: { formId: 'f', info: { title: 'T' } } }) });
    const s = source(g.fetch, () => t);
    await s.getForm('f');
    await s.getForm('f');
    t += 3600_000 - 30_000;
    await s.getForm('f');
    expect(g.calls.filter((c) => c.url === TOKEN)).toHaveLength(2);
  });

  it('explains an expired or revoked approval in plain words', async () => {
    const g = fakeGoogle({ [TOKEN]: () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }) });
    await expect(source(g.fetch).listForms()).rejects.toThrow('Google no longer accepts the saved approval (it expired or was revoked). Reconnect Google in the owner area.');
  });
});

describe('errors', () => {
  it('reports Google\'s message without ever including the secrets or tokens', async () => {
    const g = fakeGoogle({ [TOKEN]: okToken, [FORMS]: () => ({ status: 403, body: { error: { message: 'The caller does not have permission' } } }) });
    const err = await source(g.fetch).getForm('f').catch((e: Error) => e);
    expect((err as Error).message).toBe('Google API 403 for /v1/forms/f: The caller does not have permission');
    for (const secret of ['access-123', 'refresh-abc', 'secret-xyz']) expect((err as Error).message).not.toContain(secret);
  });

  it('sends the refresh token only to Google\'s token address', async () => {
    const g = fakeGoogle({ [TOKEN]: okToken, [DRIVE]: () => ({ body: { files: [] } }) });
    await source(g.fetch).listForms();
    for (const c of g.calls.filter((x) => x.url !== TOKEN)) {
      expect(c.url).not.toContain('refresh-abc');
      expect(String(c.init?.body ?? '')).not.toContain('refresh-abc');
    }
  });
});
