import { createFakeSource } from '../fake-google/source.ts';
import { googleSourceFromEnv } from '../lib/google-api.ts';
import type { FormsSource } from '../lib/sync.ts';

/** Where sync reads from: FORMS_SOURCE=google for the real forms, otherwise the fake ones. */
export function formsSource(): FormsSource {
  const kind = process.env.FORMS_SOURCE ?? 'fake';
  if (kind === 'fake') return createFakeSource();
  if (kind === 'google') {
    const source = googleSourceFromEnv();
    if (!source) throw new Error('FORMS_SOURCE=google needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN');
    return source;
  }
  throw new Error(`Unknown FORMS_SOURCE=${kind}`);
}
