// Read-only walkthrough of the Gmail connection: lists the forms your mail mentions, and whether
// each was answered. Touches neither Gmail nor the database — it only reads and prints.
import { applicationsIn } from '../src/lib/applications.ts';
import { FORM_MAIL_QUERY, mailboxFromEnv } from '../src/lib/gmail.ts';

const mailbox = mailboxFromEnv();
if (!mailbox) {
  console.error('Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN first (see README, "Connect Google").');
  process.exit(1);
}

const max = Number(process.argv[2] ?? 500);
let address: string;
try {
  address = await mailbox.address();
} catch (err) {
  console.error(`${(err as Error).message}\n`);
  console.error('If that mentions a scope or insufficient permission, the saved approval predates Gmail:');
  console.error('redo the approval including https://www.googleapis.com/auth/gmail.readonly (see README, "Forms you applied to").');
  process.exit(1);
}

console.log(`Reading ${address} for mail mentioning a Google Form (at most ${max} messages).\n`);
const messages = await mailbox.search(FORM_MAIL_QUERY, max);
const found = messages.flatMap(applicationsIn);

if (!messages.length) {
  console.log('No mail mentions a Google Form at all. Nothing can be found this way.');
  process.exit(0);
}

const byForm = new Map<string, { form: string; status: string; when: string; link: string }>();
for (const a of found) {
  const existing = byForm.get(a.formId);
  if (!existing || (a.status === 'submitted' && existing.status !== 'submitted')) {
    byForm.set(a.formId, {
      form: a.title.slice(0, 60),
      status: a.status === 'submitted' ? 'submitted' : 'found (not known to be sent)',
      when: a.appliedAt.toISOString().slice(0, 10),
      link: a.link.slice(0, 60),
    });
  }
}

console.table([...byForm.values()].sort((a, b) => b.when.localeCompare(a.when)));
const submitted = [...byForm.values()].filter((r) => r.status === 'submitted').length;
console.log(`\n${messages.length} message(s) mention a form; ${byForm.size} distinct form(s); ${submitted} known to have been sent.`);
if (submitted < byForm.size) {
  console.log('The rest reached you but left no receipt, so whether you answered them cannot be told from mail.');
}
