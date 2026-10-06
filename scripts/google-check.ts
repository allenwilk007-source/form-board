// Read-only walkthrough of the real Google connection: lists the forms the site would show, with
// whether each is open, its email setting and its response count. Changes nothing anywhere.
import { collectsVerifiedEmails, isAcceptingResponses } from '../src/lib/google.ts';
import { FORM_WINDOW_DAYS, googleSourceFromEnv } from '../src/lib/google-api.ts';

const source = googleSourceFromEnv();
if (!source) {
  console.error('Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN first (see README, "Connect Google").');
  process.exit(1);
}

const ids = await source.listForms();
console.log(`Connected. Found ${ids.length} form${ids.length === 1 ? '' : 's'} you own, created in the last ${FORM_WINDOW_DAYS} days.\n`);
const rows = [];
for (const id of ids) {
  try {
    const form = await source.getForm(id);
    const responses = await source.listResponses(id);
    const withEmail = responses.filter((r) => r.respondentEmail).length;
    rows.push({
      form: form.info.title || '(untitled)',
      open: isAcceptingResponses(form) ? 'open' : 'closed',
      emails: form.settings?.emailCollectionType ?? 'not reported',
      responses: responses.length,
      'matched to a person': collectsVerifiedEmails(form) ? withEmail : 0,
      'shown in Open forms': isAcceptingResponses(form) ? 'yes' : 'no',
    });
  } catch (err) {
    rows.push({ form: id, open: 'error', emails: (err as Error).message.slice(0, 80), responses: 0, 'matched to a person': 0, 'shown in Open forms': 'no' });
  }
}
console.table(rows);
const unverified = rows.filter((r) => r.emails !== 'VERIFIED' && r.open !== 'error').length;
if (unverified) console.log(`\n${unverified} form(s) don't collect Verified emails, so their responses can't be shown to the people who sent them.`);
