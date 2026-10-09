import { describe, expect, it } from 'vitest';
import { formLinks, resolveShortLink, resolveShortLinks, safeFormHref } from '../src/lib/form-links.ts';

const PUBLISHED = '1FAIpQLSdsw98ypAQdRyxYlr5z5ysy5EwEyiGVMEGMyF5LMINzp4pT3g';
const DIRECT = '1sLls-XCt1OLH5jsti1vLGTKFEpBnbJD4-7zur51w3CY';

describe('finding forms in an email', () => {
  it('finds the published link a responder is sent', () => {
    expect(formLinks(`Thanks. https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`)).toEqual([
      { id: PUBLISHED, kind: 'published', url: `https://docs.google.com/forms/d/e/${PUBLISHED}/viewform` },
    ]);
  });

  it('finds an editing link too, and keeps the two kinds apart', () => {
    const found = formLinks(`a https://docs.google.com/forms/d/${DIRECT}/edit and b https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`);
    expect(found.map((f) => f.kind)).toEqual(['direct', 'published']);
    expect(found.map((f) => f.id)).toEqual([DIRECT, PUBLISHED]);
  });

  it('keeps the edit-response link whole, query string and all', () => {
    const url = `https://docs.google.com/forms/d/e/${PUBLISHED}/viewform?edit2=2_ABaOnucT8Xk_w`;
    expect(formLinks(`Edit your response: ${url}`)[0].url).toBe(url);
  });

  it('counts a form once however many times it is linked', () => {
    const text = `
      <a href="https://docs.google.com/forms/d/e/${PUBLISHED}/viewform">View</a>
      <a href="https://docs.google.com/forms/d/e/${PUBLISHED}/viewform?edit2=abc">Edit your response</a>
      https://docs.google.com/forms/d/e/${PUBLISHED}/viewform
    `;
    expect(formLinks(text)).toHaveLength(1);
  });

  it('finds several different forms, in the order they appear', () => {
    const other = '1FAIpQLSf_ANOTHER_FORM_ID_abcdefghijklmnop';
    const found = formLinks(`https://docs.google.com/forms/d/e/${other}/viewform then https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`);
    expect(found.map((f) => f.id)).toEqual([other, PUBLISHED]);
  });

  it('drops the punctuation a link picks up from a sentence', () => {
    expect(formLinks(`See https://docs.google.com/forms/d/e/${PUBLISHED}/viewform.`)[0].url).toBe(
      `https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`,
    );
    expect(formLinks(`(https://docs.google.com/forms/d/e/${PUBLISHED}/viewform)`)[0].url).not.toContain(')');
  });

  it('copes with the HTML entities an email body arrives with', () => {
    const text = `href=&quot;https://docs.google.com/forms/d/e/${PUBLISHED}/viewform?usp=sf_link&amp;entry=1&quot;`;
    expect(formLinks(text)[0].id).toBe(PUBLISHED);
  });

  it('works whatever language the email is in, because it never reads the words', () => {
    const japanese = `ご回答ありがとうございました。https://docs.google.com/forms/d/e/${PUBLISHED}/viewform を編集できます。`;
    expect(formLinks(japanese)[0].id).toBe(PUBLISHED);
  });

  it('accepts http as well as https', () => {
    expect(formLinks(`http://docs.google.com/forms/d/e/${PUBLISHED}/viewform`)).toHaveLength(1);
  });

  it.each([
    ['nothing at all', ''],
    ['an email with no form in it', 'Your parcel is on its way. Track it at https://example.org/track/123'],
    ['a Google link that is not a form', 'https://docs.google.com/document/d/1abcdefghij/edit'],
    ['a sheet, not a form', 'https://docs.google.com/spreadsheets/d/1abcdefghij/edit'],
    ['a look-alike host', 'https://docs.google.com.evil.example/forms/d/e/abcdefghij/viewform'],
    ['a form word with no link', 'Please fill in the form at docs.google.com slash forms'],
  ])('finds nothing in %s', (_, text) => {
    expect(formLinks(text)).toEqual([]);
  });

  it('refuses an id too short to be real, so stray paths are not mistaken for forms', () => {
    expect(formLinks('https://docs.google.com/forms/d/short/edit')).toEqual([]);
  });
});

describe('keeping the link that proves a submission', () => {
  const view = `https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`;
  const edit = `https://docs.google.com/forms/d/e/${PUBLISHED}/viewform?edit2=2_ABaOnuc`;

  it('keeps the edit-your-response link when it comes after a plain link to the same form', () => {
    // A receipt that says "view the form" before "edit your response" must still count as sent.
    expect(formLinks(`View: ${view}\nEdit your response: ${edit}`)).toEqual([{ id: PUBLISHED, kind: 'published', url: edit }]);
  });

  it('keeps it when it comes first, too', () => {
    expect(formLinks(`Edit your response: ${edit}\nView: ${view}`)[0].url).toBe(edit);
  });
});

describe('forms.gle short links', () => {
  it('finds a short link and marks it as not yet followed', () => {
    expect(formLinks('Apply here: https://forms.gle/aBcD3fGh1jK2')).toEqual([
      { id: 'aBcD3fGh1jK2', kind: 'short', url: 'https://forms.gle/aBcD3fGh1jK2' },
    ]);
  });

  it('keeps a whole code that contains a hyphen or underscore instead of cutting it short', () => {
    expect(formLinks('https://forms.gle/ab-cd_ef12')[0].id).toBe('ab-cd_ef12');
  });

  it('lists short and long links in the order they appear', () => {
    const found = formLinks(`https://forms.gle/shortOne1 then https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`);
    expect(found.map((f) => f.kind)).toEqual(['short', 'published']);
  });

  it.each([
    ['a look-alike host', 'https://forms.gle.evil.example/abcdef'],
    ['a host ending in forms.gle', 'https://evilforms.gle/abcdef'],
    ['a code too short to be real', 'https://forms.gle/ab'],
  ])('finds nothing in %s', (_, text) => {
    expect(formLinks(text)).toEqual([]);
  });
});

/** A pretend forms.gle: answers by URL with a status and an optional Location, and records every call. */
function fakeShortener(routes: Record<string, { status: number; location?: string } | 'network-error'>) {
  const calls: { url: string; redirect?: RequestRedirect }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, redirect: init?.redirect });
    const route = routes[url];
    if (route === 'network-error') throw new TypeError('fetch failed');
    if (!route) return new Response('not found', { status: 404 });
    return new Response(null, { status: route.status, headers: route.location ? { location: route.location } : {} });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('following a short link', () => {
  const long = `https://docs.google.com/forms/d/e/${PUBLISHED}/viewform?usp=send_form`;

  it('follows the redirect to the form it leads to', async () => {
    const s = fakeShortener({ 'https://forms.gle/abc123': { status: 302, location: long } });
    expect(await resolveShortLink('abc123', s.fetch)).toEqual({ id: PUBLISHED, kind: 'published', url: long });
  });

  it('reads the redirect itself rather than letting fetch follow it', async () => {
    const s = fakeShortener({ 'https://forms.gle/abc123': { status: 302, location: long } });
    await resolveShortLink('abc123', s.fetch);
    expect(s.calls[0].redirect).toBe('manual');
  });

  it('never fetches the form itself, only forms.gle', async () => {
    const s = fakeShortener({ 'https://forms.gle/abc123': { status: 301, location: long } });
    await resolveShortLink('abc123', s.fetch);
    expect(s.calls.map((c) => new URL(c.url).host)).toEqual(['forms.gle']);
  });

  it('assumes nothing about the shape of the destination: any form link Google lands on will do', async () => {
    const direct = 'https://docs.google.com/forms/d/1sLls-XCt1OLH5jsti1vLGTKFEpBnbJD4-7zur51w3CY/viewform';
    const s = fakeShortener({ 'https://forms.gle/abc123': { status: 302, location: direct } });
    expect((await resolveShortLink('abc123', s.fetch))?.kind).toBe('direct');
  });

  it('follows a further forms.gle hop', async () => {
    const s = fakeShortener({
      'https://forms.gle/abc123': { status: 302, location: 'https://forms.gle/xyz789' },
      'https://forms.gle/xyz789': { status: 302, location: long },
    });
    expect((await resolveShortLink('abc123', s.fetch))?.id).toBe(PUBLISHED);
  });

  it('gives up on a redirect loop instead of following it for ever', async () => {
    const s = fakeShortener({
      'https://forms.gle/aaaa': { status: 302, location: 'https://forms.gle/bbbb' },
      'https://forms.gle/bbbb': { status: 302, location: 'https://forms.gle/aaaa' },
    });
    expect(await resolveShortLink('aaaa', s.fetch)).toBeNull();
    expect(s.calls).toHaveLength(3);
  });

  it('does not follow a redirect anywhere but forms.gle, so an email cannot steer it elsewhere', async () => {
    const s = fakeShortener({ 'https://forms.gle/abc123': { status: 302, location: 'https://internal.example/admin' } });
    expect(await resolveShortLink('abc123', s.fetch)).toBeNull();
    expect(s.calls).toHaveLength(1);
  });

  it('does not follow a downgrade to plain http', async () => {
    const s = fakeShortener({ 'https://forms.gle/abc123': { status: 302, location: 'http://forms.gle/xyz789' } });
    expect(await resolveShortLink('abc123', s.fetch)).toBeNull();
    expect(s.calls).toHaveLength(1);
  });

  it.each([
    ['a dead link', { status: 404 }],
    ['a page instead of a redirect', { status: 200 }],
    ['a redirect with nowhere to go', { status: 302 }],
  ])('gives up quietly on %s', async (_, route) => {
    expect(await resolveShortLink('abc123', fakeShortener({ 'https://forms.gle/abc123': route }).fetch)).toBeNull();
  });

  it('gives up quietly when forms.gle cannot be reached at all', async () => {
    expect(await resolveShortLink('abc123', fakeShortener({ 'https://forms.gle/abc123': 'network-error' }).fetch)).toBeNull();
  });
});

describe('following many short links', () => {
  const long = (id: string) => `https://docs.google.com/forms/d/e/${id}${'x'.repeat(10)}/viewform`;

  it('follows each code once, however many emails carry it', async () => {
    const s = fakeShortener({ 'https://forms.gle/abc123': { status: 302, location: long('A') } });
    await resolveShortLinks(['abc123', 'abc123', 'abc123'], s.fetch);
    expect(s.calls).toHaveLength(1);
  });

  it('keeps the ones it could follow when others fail, so one dead link never sinks a scan', async () => {
    const s = fakeShortener({
      'https://forms.gle/good1': { status: 302, location: long('A') },
      'https://forms.gle/dead1': 'network-error',
      'https://forms.gle/good2': { status: 302, location: long('B') },
    });
    const resolved = await resolveShortLinks(['good1', 'dead1', 'good2'], s.fetch);
    expect([...resolved.keys()]).toEqual(['good1', 'good2']);
  });
});

describe('making a stored link safe to click', () => {
  it.each([
    ['a published form', `https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`],
    ['an edit-your-response link', `https://docs.google.com/forms/d/e/${PUBLISHED}/viewform?edit2=2_ABa`],
    ['a short link', 'https://forms.gle/aBcD3fGh1jK2'],
  ])('passes %s through unchanged', (_, link) => {
    expect(safeFormHref(link)).toBe(link);
  });

  it('upgrades plain http to https', () => {
    expect(safeFormHref(`http://docs.google.com/forms/d/e/${PUBLISHED}/viewform`)).toBe(`https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`);
  });

  it.each([
    ['javascript:', 'javascript:alert(document.cookie)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['a look-alike host', 'https://docs.google.com.evil.example/forms/d/e/x/viewform'],
    ['another Google page', 'https://docs.google.com/document/d/1abcdefghij/edit'],
    ['someone else entirely', 'https://evil.example/forms/d/e/x/viewform'],
    ['a login smuggled into the address', 'https://user:pass@docs.google.com/forms/d/e/x/viewform'],
    ['an unusual port', 'https://docs.google.com:8443/forms/d/e/x/viewform'],
    ['nonsense', 'not a url'],
  ])('refuses %s', (_, link) => {
    expect(safeFormHref(link)).toBeNull();
  });
});
