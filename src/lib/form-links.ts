// Finding Google Forms in the text of an email.
//
// Google gives no way to ask which forms a person has responded to, so the only trace of a
// submission is the "copy of your response" email the form's owner may have switched on. These
// emails have no documented sender, subject or layout, and they are translated, so nothing about
// their wording can be relied on. What does not change is the link back to the form: every such
// email carries one. Matching on the link rather than on the sender keeps this working when Google
// changes the wording, and in every language.
import { inOrder } from './concurrency.ts';

/** A form as it appears in a link. Google uses several ids for one form and they are not interchangeable. */
export type FormLink = {
  /**
   * The id in the link. For /forms/d/e/<id>/viewform this is the *published* id, which is not the
   * id the Forms API uses — and cannot be converted to it. That is fine here: these are other
   * people's forms, so the API was never going to answer for them anyway. For a forms.gle link it
   * is the short code, until resolveShortLinks() swaps it for the form it leads to.
   */
  id: string;
  /** The published id (/d/e/), the editing id (/d/), or a forms.gle short code not yet followed. */
  kind: 'published' | 'direct' | 'short';
  /** The link as found, trimmed of trailing punctuation. */
  url: string;
};

// Every shape Google uses: the two long ones, and forms.gle short links. The id charset is
// deliberately wide: Google has changed its id format before, and a too-strict pattern would
// silently stop matching. The host must follow the scheme directly, so look-alikes such as
// docs.google.com.evil.example or evilforms.gle never match.
const LINK = /https?:\/\/(?:docs\.google\.com\/forms\/d\/(e\/)?([A-Za-z0-9_-]{8,})|forms\.gle\/([A-Za-z0-9_-]{4,}))\b[^\s"'<>)\]]*/g;

/** Google's "edit your response" link: proof that a response was sent. */
export const EDIT_RESPONSE = /[?&]edit2=/;

/**
 * Every distinct Google Form linked to from a piece of text, in the order first seen. A form linked
 * several times in one email (a "view form" link, the "edit your response" link, a footer) counts
 * once — and when one of those is the edit-your-response link, that is the one kept, because it is
 * the only one that proves anything was sent.
 */
export function formLinks(text: string): FormLink[] {
  const seen = new Map<string, FormLink>();
  for (const m of text.matchAll(LINK)) {
    const link: FormLink = m[3]
      ? { id: m[3], kind: 'short', url: trimTrailing(m[0]) }
      : { id: m[2], kind: m[1] ? 'published' : 'direct', url: trimTrailing(m[0]) };
    keep(seen, link);
  }
  return [...seen.values()];
}

/** Adds a link to a de-duplicated set, upgrading an existing entry to its edit-your-response link. */
export function keep(seen: Map<string, FormLink>, link: FormLink): void {
  const key = `${link.kind}:${link.id}`;
  const existing = seen.get(key);
  if (!existing || (!EDIT_RESPONSE.test(existing.url) && EDIT_RESPONSE.test(link.url))) seen.set(key, link);
}

/** Drops punctuation a link picks up from the sentence around it, and any HTML entity tail. */
function trimTrailing(url: string): string {
  return url.replace(/(&amp;|&quot;|&gt;|&lt;|[.,;:!?])+$/, '');
}

/** How long to wait for forms.gle before giving up on one link. */
const RESOLVE_TIMEOUT_MS = 5000;
/** forms.gle answers with a single redirect; a few allows for that changing without looping forever. */
const MAX_HOPS = 3;

/**
 * Follows a forms.gle short code to the form it leads to, or null if it cannot be told.
 *
 * Nothing about where forms.gle sends people is assumed: wherever the redirect lands is read by the
 * same parser as every other link, so this keeps working if Google changes the shape of that URL.
 * Only forms.gle itself is ever fetched — a redirect anywhere else ends the trail rather than being
 * followed — so a link in somebody's email cannot steer this into requesting an arbitrary address.
 * Nothing is read from the response but its Location header.
 */
export async function resolveShortLink(code: string, doFetch: typeof fetch = fetch): Promise<FormLink | null> {
  let url = `https://forms.gle/${code}`;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let res: Response;
    try {
      res = await doFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
    } catch {
      return null;
    }
    await res.body?.cancel().catch(() => {});
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return null;
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return null;
    }
    const form = formLinks(next.toString()).find((l) => l.kind !== 'short');
    if (form) return form;
    if (next.protocol !== 'https:' || next.host !== 'forms.gle') return null;
    url = next.toString();
  }
  return null;
}

/**
 * Follows several short codes, a few at a time. Each is followed once however many emails carry
 * it. Codes that cannot be followed are simply absent from the answer: one dead link never fails a
 * whole scan.
 */
export async function resolveShortLinks(codes: Iterable<string>, doFetch: typeof fetch = fetch): Promise<Map<string, FormLink>> {
  const distinct = [...new Set(codes)];
  const results = await inOrder(distinct, 4, (code) => resolveShortLink(code, doFetch));
  const out = new Map<string, FormLink>();
  distinct.forEach((code, i) => {
    const form = results[i];
    if (form) out.set(code, form);
  });
  return out;
}

/**
 * A stored form link made safe to put in an href, or null. Links come from the text of somebody's
 * email, so before one becomes something a person can click it must be a plain web address on
 * Google Forms itself — never javascript:, data:, or a look-alike host — and is always sent over
 * https. The parser already only stores such links; this does not rely on that.
 */
export function safeFormHref(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const onForms = (url.host === 'docs.google.com' && url.pathname.startsWith('/forms/')) || url.host === 'forms.gle';
  if (!onForms || url.username || url.password || url.port) return null;
  url.protocol = 'https:';
  return url.toString();
}
