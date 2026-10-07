// Finding Google Forms in the text of an email.
//
// Google gives no way to ask which forms a person has responded to, so the only trace of a
// submission is the "copy of your response" email the form's owner may have switched on. These
// emails have no documented sender, subject or layout, and they are translated, so nothing about
// their wording can be relied on. What does not change is the link back to the form: every such
// email carries one. Matching on the link rather than on the sender keeps this working when Google
// changes the wording, and in every language.

/** A form as it appears in a link. Google uses two different ids and they are not interchangeable. */
export type FormLink = {
  /**
   * The id in the link. For /forms/d/e/<id>/viewform this is the *published* id, which is not the
   * id the Forms API uses — and cannot be converted to it. That is fine here: these are other
   * people's forms, so the API was never going to answer for them anyway.
   */
  id: string;
  /** Whether the id is the published one (/d/e/) or the editing one (/d/). */
  kind: 'published' | 'direct';
  /** The link as found, trimmed of trailing punctuation. */
  url: string;
};

// Both shapes Google uses. The id charset is deliberately wide: Google has changed its id format
// before, and a too-strict pattern would silently stop matching.
const LINK = /https?:\/\/docs\.google\.com\/forms\/d\/(e\/)?([A-Za-z0-9_-]{8,})\b[^\s"'<>)\]]*/g;

/**
 * Every distinct Google Form linked to from a piece of text, in the order first seen. A form linked
 * several times in one email (the "edit your response" link, a footer, a logo) counts once.
 */
export function formLinks(text: string): FormLink[] {
  const seen = new Map<string, FormLink>();
  for (const m of text.matchAll(LINK)) {
    const kind = m[1] ? 'published' : 'direct';
    const id = m[2];
    const key = `${kind}:${id}`;
    if (!seen.has(key)) seen.set(key, { id, kind, url: trimTrailing(m[0]) });
  }
  return [...seen.values()];
}

/** Drops punctuation a link picks up from the sentence around it, and any HTML entity tail. */
function trimTrailing(url: string): string {
  return url.replace(/(&amp;|&quot;|&gt;|&lt;|[.,;:!?])+$/, '');
}
