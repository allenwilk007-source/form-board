// Reading the owner's Gmail, to find the Google Forms they have been sent or have answered.
//
// Google offers no way to ask which forms a person has responded to, so mail is the only trace.
// Two kinds of message matter, and both are found the same way, by the link they carry:
//   - the invitation that sent them the form, which arrives before they answer;
//   - the "copy of your response" receipt, which arrives after, when the form's owner switched it on.
// Nothing here reads the wording of a message, so it works whatever language the mail is in.
import { createGet, createTokenSource, type TokenOptions } from './google-token.ts';

/** Read-only, and only the owner's own mailbox. Google counts this a restricted permission. */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** Finds mail mentioning a form, by link. Both Google's own host and its short links. */
export const FORM_MAIL_QUERY = '"docs.google.com/forms" OR "forms.gle"';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type MailMessage = {
  id: string;
  /** Best effort: whatever the sender put in the subject. Can be unhelpful or empty. */
  subject: string;
  from: string;
  receivedAt: Date;
  /** Every text part of the message, decoded and run together. Searched for links, never read. */
  text: string;
};

type Options = TokenOptions & { fetch?: typeof fetch };

export type Mailbox = {
  /** The address of the mailbox being read, as Google reports it. */
  address(): Promise<string>;
  /** Messages matching a Gmail search, newest first. `max` caps how many are fetched. */
  search(query: string, max?: number): Promise<MailMessage[]>;
};

type RawPart = { mimeType?: string; body?: { data?: string }; parts?: RawPart[] };
type RawMessage = { id: string; internalDate?: string; payload?: RawPart & { headers?: { name: string; value: string }[] } };

export function createMailbox(opts: Options): Mailbox {
  const doFetch = opts.fetch ?? fetch;
  const get = createGet(createTokenSource({ ...opts, fetch: doFetch }), doFetch);

  return {
    async address() {
      return (await get<{ emailAddress?: string }>(`${API}/profile`)).emailAddress ?? '';
    },

    async search(query, max = 500) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ q: query, maxResults: String(Math.min(500, max - ids.length)) });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await get<{ messages?: { id: string }[]; nextPageToken?: string }>(`${API}/messages?${params}`);
        ids.push(...(page.messages ?? []).map((m) => m.id));
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < max);

      const out: MailMessage[] = [];
      for (const id of ids.slice(0, max)) out.push(readMessage(await get<RawMessage>(`${API}/messages/${encodeURIComponent(id)}?format=full`)));
      return out;
    },
  };
}

/** One Gmail message flattened into the few things that matter here. */
export function readMessage(raw: RawMessage): MailMessage {
  const header = (name: string) => raw.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
  const sent = Number(raw.internalDate);
  return {
    id: raw.id,
    subject: header('subject'),
    from: header('from'),
    // internalDate is when Google received it. A message without one is dated now, so it still shows.
    receivedAt: new Date(Number.isFinite(sent) && sent > 0 ? sent : Date.now()),
    text: partsText(raw.payload),
  };
}

/** Every text part of a message, however deeply nested, decoded and joined. */
function partsText(part: RawPart | undefined, depth = 0): string {
  if (!part || depth > 10) return '';
  const here = part.body?.data ? decode(part.body.data) : '';
  const below = (part.parts ?? []).map((p) => partsText(p, depth + 1)).join('\n');
  return [here, below].filter(Boolean).join('\n');
}

/** Gmail hands body text back base64url-encoded. Junk decodes to nothing rather than throwing. */
function decode(data: string): string {
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/** The owner's mailbox from environment variables, or null when Gmail reading isn't set up. */
export function mailboxFromEnv(): Mailbox | null {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: refreshToken } = process.env;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return createMailbox({ clientId, clientSecret, refreshToken });
}
