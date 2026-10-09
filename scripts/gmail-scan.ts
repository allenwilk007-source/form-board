// Reads the owner's mail for Google Forms and stores what it finds. Safe to run again and again:
// rows are keyed on the Gmail message, so nothing is ever stored twice.
//
// After the first run it only fetches mail received since the last complete scan, so a routine run
// is a handful of requests rather than one per matching message in the whole mailbox.
// `npm run gmail:scan -- 2000` raises the cap; `npm run gmail:scan -- 500 --full` reads everything again.
import pg from 'pg';
import { listApplications, markReadThrough, readThrough, saveApplications, scanMailbox } from '../src/lib/applications.ts';
import { requireEnv } from '../src/lib/db.ts';
import { mailboxFromEnv } from '../src/lib/gmail.ts';

const mailbox = mailboxFromEnv();
if (!mailbox) {
  console.error('Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN first (see README, "Connect Google").');
  process.exit(1);
}

const args = process.argv.slice(2);
const max = Number(args.find((a) => /^\d+$/.test(a)) ?? 500);
const full = args.includes('--full');

const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
try {
  const address = await mailbox.address();
  // Taken before reading, so mail that arrives during the scan is picked up by the next one.
  const startedAt = new Date();
  const since = full ? null : await readThrough(pool, address);
  console.log(since ? `Reading ${address} for mail since ${since.toISOString()}.` : `Reading all of ${address} (first scan, or --full).`);

  const scan = await scanMailbox(mailbox, { max, since });
  const { added, updated } = await saveApplications(pool, address, scan.found);

  if (scan.complete) {
    await markReadThrough(pool, address, startedAt);
  } else {
    // Gmail returns newest first, so the cap left the *oldest* mail unread. Moving the marker
    // forward now would skip it for good, so it stays put and the next run tries again.
    console.warn(
      `\nStopped at ${max} messages before reaching the oldest matching mail, so the next run will start from the same point.` +
        `\nRun with a higher cap to read it all once, e.g. npm run gmail:scan -- ${max * 4}`,
    );
  }

  if (scan.unresolved) {
    console.warn(
      `\n${scan.unresolved} of ${scan.shortLinks} forms.gle short link(s) could not be followed. They are stored by their short code ` +
        `and will not be matched with other mail about the same form until they can be; if none could be followed, forms.gle is probably unreachable from here.`,
    );
  }

  const all = await listApplications(pool, address);
  console.log(`\n${scan.messages} message(s) read, ${added} application(s) new, ${updated} changed; ${all.length} in total.`);
  console.table(all.map((r) => ({ form: r.title.slice(0, 60), status: r.status, when: r.applied_at.toISOString().slice(0, 10) })));
} catch (err) {
  const message = (err as Error).message;
  console.error(message);
  if (/scope|insufficient|permission/i.test(message)) {
    console.error('\nThe saved approval predates Gmail: redo it including https://www.googleapis.com/auth/gmail.readonly');
    console.error('(see README, "Forms you applied to").');
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
