import { createFakeSource } from '../fake-google/source.ts';
import type { FormsSource } from '../lib/sync.ts';

/** Where sync reads from. Only the fake source exists until go-live adds the Google Forms API client. */
export function formsSource(): FormsSource {
  if ((process.env.FORMS_SOURCE ?? 'fake') !== 'fake') throw new Error(`FORMS_SOURCE=${process.env.FORMS_SOURCE} is not available yet`);
  return createFakeSource();
}
