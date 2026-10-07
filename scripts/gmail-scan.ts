// Reads the owner's mail for Google Forms and stores what it finds. Safe to run again and again:
// rows are keyed on the Gmail message, so nothing is ever stored twice.
import pg from 'pg';
import { listApplications, saveApplications, scanMailbox } from '../src/lib/applications.ts';
import { requireEnv } from '../src/lib/db.ts';
import { mailboxFromEnv } from '../src/lib/gmail.ts';

const mailbox = mailboxFromEnv();
if (!mailbox) {
  console.error('Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN first (see README, "Connect Google").');
  process.exit(1);
}

const max = Number(process.argv[2] ?? 500);
const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
try {
  const address = await mailbox.address();
  const found = await scanMailbox(mailbox, { max });
  const { added, updated } = await saveApplications(pool, address, found);
  const all = await listApplications(pool, address);
  console.log(`Read ${address}: ${found.length} mention(s) of a form, ${added} new, ${updated} changed.`);
  console.table(
    all.map((r) => ({ form: r.title.slice(0, 60), status: r.status, when: r.applied_at.toISOString().slice(0, 10) })),
  );
} finally {
  await pool.end();
}
