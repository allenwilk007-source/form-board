// The Gmail reader, against a pretend Gmail. Nothing here touches a real mailbox.
import { describe, expect, it } from 'vitest';
import { applicationsIn } from '../src/lib/applications.ts';
import { createMailbox, FORM_MAIL_QUERY, readMessage, receivedAfter } from '../src/lib/gmail.ts';

const PUBLISHED = '1FAIpQLSdsw98ypAQdRyxYlr5z5ysy5EwEyiGVMEGMyF5LMINzp4pT3g';
const TOKEN = 'https://oauth2.googleapis.com/token';
const PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const LIST = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?';
const MESSAGE = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** A pretend Gmail: answers by URL prefix, records every call. */
function fakeGmail(routes: Record<string, (url: URL) => { status?: number; body: unknown }>) {
  const calls: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.toString().startsWith(k));
    if (!key) return new Response('{}', { status: 404 });
    const { status = 200, body } = routes[key](url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}
const okToken = () => ({ body: { access_token: 'access-123', expires_in: 3600 } });
const mailbox = (fetch: typeof globalThis.fetch) =>
  createMailbox({ clientId: 'cid', clientSecret: 'secret-xyz', refreshToken: 'refresh-abc', fetch });

/** A Gmail message as the API returns one. */
const msg = (id: string, subject: string, text: string, date = Date.parse('2026-09-01T10:00:00Z')) => ({
  id,
  internalDate: String(date),
  payload: {
    headers: [
      { name: 'Subject', value: subject },
      { name: 'From', value: 'someone@example.org' },
    ],
    body: { data: b64(text) },
  },
});

describe('reading a message', () => {
  it('takes the subject, sender and date, and decodes the body', () => {
    const m = readMessage(msg('m1', 'Apply now', `Fill in https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`));
    expect(m).toMatchObject({ id: 'm1', subject: 'Apply now', from: 'someone@example.org' });
    expect(m.receivedAt.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(m.text).toContain('docs.google.com/forms');
  });

  it('finds headers whatever case Gmail sends them in', () => {
    const m = readMessage({ id: 'm1', internalDate: '1', payload: { headers: [{ name: 'SUBJECT', value: 'Shouty' }] } });
    expect(m.subject).toBe('Shouty');
  });

  it('gathers the text from every part of a multipart message', () => {
    const m = readMessage({
      id: 'm1',
      internalDate: '1',
      payload: {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('plain part') },
          },
          { mimeType: 'multipart/related', parts: [{ mimeType: 'text/html', body: { data: b64('<p>html part</p>') } }] },
        ],
      },
    });
    expect(m.text).toContain('plain part');
    expect(m.text).toContain('html part');
  });

  it('survives a message with no body, no headers and no date', () => {
    const m = readMessage({ id: 'm1' });
    expect(m).toMatchObject({ id: 'm1', subject: '', from: '', text: '' });
    expect(m.receivedAt.getTime()).toBeGreaterThan(0);
  });

  it('treats an undecodable body as empty rather than failing the whole scan', () => {
    expect(readMessage({ id: 'm1', payload: { body: { data: '!!!not base64!!!' } } }).text).not.toContain('!!!');
  });
});

describe('searching the mailbox', () => {
  it('asks Gmail for mail carrying a form link, and reads each message found', async () => {
    const g = fakeGmail({
      [TOKEN]: okToken,
      [LIST]: () => ({ body: { messages: [{ id: 'm1' }] } }),
      [MESSAGE]: () => ({ body: msg('m1', 'Apply', `https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`) }),
    });
    const { messages: found, complete } = await mailbox(g.fetch).search(FORM_MAIL_QUERY);
    expect(found).toHaveLength(1);
    expect(complete).toBe(true);
    expect(new URL(g.calls[1]).searchParams.get('q')).toBe('"docs.google.com/forms" OR "forms.gle"');
    // Short links count too: a form reached by forms.gle is still a form.
    expect(FORM_MAIL_QUERY).toContain('forms.gle');
  });

  it('follows every page of results', async () => {
    const g = fakeGmail({
      [TOKEN]: okToken,
      [LIST]: (url) => (url.searchParams.get('pageToken') ? { body: { messages: [{ id: 'm3' }] } } : { body: { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'p2' } }),
      [MESSAGE]: (url) => ({ body: msg(url.pathname.split('/').pop()!.split('?')[0], 'S', 'no links here') }),
    });
    const { messages, complete } = await mailbox(g.fetch).search('q');
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(complete).toBe(true);
  });

  it('stops at the cap instead of reading a whole mailbox, and says it stopped short', async () => {
    const g = fakeGmail({
      [TOKEN]: okToken,
      [LIST]: () => ({ body: { messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], nextPageToken: 'more' } }),
      [MESSAGE]: (url) => ({ body: msg(url.pathname.split('/').pop()!.split('?')[0], 'S', 'x') }),
    });
    const { messages, complete } = await mailbox(g.fetch).search('q', 2);
    expect(messages).toHaveLength(2);
    // The oldest mail went unread: anything keeping a bookmark must not move past it.
    expect(complete).toBe(false);
  });

  it('counts a search that exactly fills the cap, with nothing beyond it, as complete', async () => {
    const g = fakeGmail({
      [TOKEN]: okToken,
      [LIST]: () => ({ body: { messages: [{ id: 'm1' }, { id: 'm2' }] } }),
      [MESSAGE]: (url) => ({ body: msg(url.pathname.split('/').pop()!.split('?')[0], 'S', 'x') }),
    });
    expect((await mailbox(g.fetch).search('q', 2)).complete).toBe(true);
  });

  it('reads messages several at a time but hands them back newest first, as Gmail listed them', async () => {
    let inFlight = 0;
    let most = 0;
    const ids = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const base = fakeGmail({ [TOKEN]: okToken, [LIST]: () => ({ body: { messages: ids.map((id) => ({ id })) } }) });
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(MESSAGE) || url.startsWith(LIST)) return base.fetch(input, init);
      inFlight++;
      most = Math.max(most, inFlight);
      const id = new URL(url).pathname.split('/').pop()!;
      // Later messages answer sooner, so finishing order is the reverse of listing order.
      await new Promise((r) => setTimeout(r, 40 - Number(id.slice(1)) * 2));
      inFlight--;
      return new Response(JSON.stringify(msg(id, `S ${id}`, 'x')), { headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const { messages } = await mailbox(fetch).search('q');
    expect(messages.map((m) => m.id)).toEqual(ids);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(8);
  });

  it('stops reading once one message fails, rather than fetching the rest only to throw them away', async () => {
    // One bad message among many good ones: the scan has failed, so the others are wasted effort.
    const g = fakeGmail({
      [TOKEN]: okToken,
      [LIST]: () => ({ body: { messages: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}` })) } }),
      [MESSAGE]: (url) =>
        url.pathname.endsWith('/m0')
          ? { status: 500, body: { error: { message: 'Backend Error' } } }
          : { body: msg(url.pathname.split('/').pop()!, 'S', 'x') },
    });
    await expect(mailbox(g.fetch).search('q')).rejects.toThrow(/Backend Error/);
    // The search rejects as soon as the first message fails, but workers still running could go on
    // fetching behind it. Let them finish whatever they would do before counting.
    await new Promise((r) => setTimeout(r, 100));
    // A request already under way when the failure lands cannot be recalled, and a quick worker may
    // start one more before it hears. So: a couple of rounds of the eight workers, not two hundred.
    const fetched = g.calls.filter((c) => c.startsWith(MESSAGE)).length;
    expect(fetched).toBeLessThanOrEqual(16);
    expect(fetched).toBeLessThan(200);
  });

  it('asks Google for one token however many messages are read at once', async () => {
    const g = fakeGmail({
      [TOKEN]: okToken,
      [LIST]: () => ({ body: { messages: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}` })) } }),
      [MESSAGE]: (url) => ({ body: msg(url.pathname.split('/').pop()!, 'S', 'x') }),
    });
    await mailbox(g.fetch).search('q');
    expect(g.calls.filter((c) => c.startsWith(TOKEN))).toHaveLength(1);
  });

  it('copes with a search that matches nothing', async () => {
    const g = fakeGmail({ [TOKEN]: okToken, [LIST]: () => ({ body: {} }) });
    expect(await mailbox(g.fetch).search('q')).toEqual({ messages: [], complete: true });
  });

  it('reports the address of the mailbox it is reading', async () => {
    const g = fakeGmail({ [TOKEN]: okToken, [PROFILE]: () => ({ body: { emailAddress: 'owner@example.org' } }) });
    expect(await mailbox(g.fetch).address()).toBe('owner@example.org');
  });

  it('passes on Gmail saying the approval does not cover mail', async () => {
    const g = fakeGmail({
      [TOKEN]: okToken,
      [PROFILE]: () => ({ status: 403, body: { error: { message: 'Request had insufficient authentication scopes.' } } }),
    });
    await expect(mailbox(g.fetch).address()).rejects.toThrow(/insufficient authentication scopes/);
  });

  it('passes on Google refusing the saved approval, without echoing the secret', async () => {
    const g = fakeGmail({ [TOKEN]: () => ({ status: 400, body: { error: 'invalid_grant' } }) });
    await expect(mailbox(g.fetch).search('q')).rejects.toThrow(/no longer accepts the saved approval/);
    await expect(mailbox(g.fetch).search('q')).rejects.not.toThrow(/secret-xyz/);
  });
});

describe('narrowing a search to recent mail', () => {
  it('adds the date as Unix seconds, which Gmail does not shift into the account\'s time zone', () => {
    expect(receivedAfter('"x"', new Date('2026-10-01T00:00:00Z'))).toBe('("x") after:1790812800');
  });

  it('brackets the original query so its OR cannot swallow the date', () => {
    // Without brackets, `a OR b after:N` reads as `a OR (b after:N)`, and every old "a" comes back.
    expect(receivedAfter(FORM_MAIL_QUERY, new Date(0))).toBe('("docs.google.com/forms" OR "forms.gle") after:0');
  });
});

describe('what a message says about a form', () => {
  const at = (text: string, subject = 'Subject here') => applicationsIn(readMessage(msg('m1', subject, text)));

  it('an invitation means the form reached you, not that you answered it', () => {
    const [a] = at(`Please apply: https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`);
    expect(a.status).toBe('found');
    expect(a.formId).toBe(PUBLISHED);
    expect(a.formIdKind).toBe('published');
  });

  it('an "edit your response" link proves you answered', () => {
    const [a] = at(`Your response: https://docs.google.com/forms/d/e/${PUBLISHED}/viewform?edit2=2_ABaOnuc`);
    expect(a.status).toBe('submitted');
  });

  it('credits only the form the edit link belongs to, not a second form named in the same receipt', () => {
    const other = '1FAIpQLSf_SOMETHING_ELSE_abcdefghijkl';
    const found = at(
      `Your response: https://docs.google.com/forms/d/e/${PUBLISHED}/viewform?edit2=abc
       See also https://docs.google.com/forms/d/e/${other}/viewform`,
    );
    expect(found.map((a) => [a.formId, a.status])).toEqual([
      [PUBLISHED, 'submitted'],
      [other, 'found'],
    ]);
  });

  it('still counts a receipt as sent when it also carries a short link that could not be followed', () => {
    // With forms.gle unreachable the share link is a separate, unknown form; it must not cast doubt
    // on the edit link, which proves its own form was sent.
    const found = at(`Edit your response: https://docs.google.com/forms/d/e/${PUBLISHED}/viewform?edit2=abc
      Share: https://forms.gle/applyNow1`);
    expect(found.map((a) => [a.formIdKind, a.status])).toEqual([
      ['published', 'submitted'],
      ['short', 'found'],
    ]);
  });

  it('uses the subject as the title, and says so plainly when there is none', () => {
    expect(at(`https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`, 'Graduate scheme 2026')[0].title).toBe('Graduate scheme 2026');
    expect(at(`https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`, '   ')[0].title).toBe('(no subject)');
  });

  it('keeps the Gmail message id, so re-scanning cannot store the same mail twice', () => {
    expect(at(`https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`)[0].gmailMessageId).toBe('m1');
  });

  it('ignores mail that mentions no form', () => {
    expect(at('Your parcel is on its way.')).toEqual([]);
  });
});
