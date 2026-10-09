// Storing what a mailbox scan found, against the real database.
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listApplications, markReadThrough, readThrough, RESCAN_OVERLAP_MS, saveApplications, scanMailbox, type Application } from '../src/lib/applications.ts';
import type { Mailbox, MailMessage } from '../src/lib/gmail.ts';
import { OWNER_URL } from './db.ts';

const pool = new pg.Pool({ connectionString: OWNER_URL });
afterAll(() => pool.end());
beforeEach(() => pool.query('TRUNCATE applications RESTART IDENTITY'));

const ME = 'owner@example.org';
const app = (over: Partial<Application> = {}): Application => ({
  formId: 'form-1',
  formIdKind: 'published',
  link: 'https://docs.google.com/forms/d/e/form-1/viewform',
  title: 'Graduate scheme',
  appliedAt: new Date('2026-09-01T10:00:00Z'),
  gmailMessageId: 'm1',
  status: 'found',
  ...over,
});

describe('storing applications', () => {
  it('stores what was found', async () => {
    expect(await saveApplications(pool, ME, [app()])).toEqual({ added: 1, updated: 0 });
    expect(await listApplications(pool, ME)).toMatchObject([{ form_id: 'form-1', title: 'Graduate scheme', status: 'found' }]);
  });

  it('changes nothing when the same mail is scanned again', async () => {
    await saveApplications(pool, ME, [app()]);
    expect(await saveApplications(pool, ME, [app()])).toEqual({ added: 0, updated: 0 });
    expect(await listApplications(pool, ME)).toHaveLength(1);
  });

  it('lower-cases the address, so the same mailbox is one person', async () => {
    await saveApplications(pool, 'Owner@Example.org', [app()]);
    expect(await listApplications(pool, ME)).toHaveLength(1);
  });

  it('keeps one person\'s applications away from another\'s', async () => {
    await saveApplications(pool, ME, [app()]);
    await saveApplications(pool, 'someone.else@example.org', [app({ gmailMessageId: 'm9' })]);
    expect(await listApplications(pool, ME)).toHaveLength(1);
    expect(await listApplications(pool, 'someone.else@example.org')).toHaveLength(1);
  });

  it('moves a form on to submitted when a receipt turns up later', async () => {
    await saveApplications(pool, ME, [app({ gmailMessageId: 'invite' })]);
    await saveApplications(pool, ME, [app({ gmailMessageId: 'receipt', status: 'submitted', appliedAt: new Date('2026-09-05T10:00:00Z') })]);
    expect(await listApplications(pool, ME)).toMatchObject([{ form_id: 'form-1', status: 'submitted' }]);
  });

  it('never walks a submitted form back, however much later mail arrives about it', async () => {
    await saveApplications(pool, ME, [app({ gmailMessageId: 'receipt', status: 'submitted' })]);
    // A reminder for the same form, in the same mail thread, says nothing about the answer already sent.
    await saveApplications(pool, ME, [app({ gmailMessageId: 'receipt', status: 'found', appliedAt: new Date('2026-10-01T10:00:00Z') })]);
    expect((await listApplications(pool, ME))[0].status).toBe('submitted');
  });

  it('shows a form once however many mails mention it', async () => {
    await saveApplications(pool, ME, [
      app({ gmailMessageId: 'm1' }),
      app({ gmailMessageId: 'm2', title: 'Reminder: graduate scheme' }),
      app({ gmailMessageId: 'm3', title: 'Last chance' }),
    ]);
    expect(await listApplications(pool, ME)).toHaveLength(1);
  });

  it('prefers the mail that proves the most when a form was mentioned several times', async () => {
    await saveApplications(pool, ME, [
      app({ gmailMessageId: 'later-reminder', status: 'found', title: 'Reminder', appliedAt: new Date('2026-10-01T10:00:00Z') }),
      app({ gmailMessageId: 'receipt', status: 'submitted', title: 'Your response', appliedAt: new Date('2026-09-02T10:00:00Z') }),
    ]);
    // The newer mail is only a reminder; the older one proves it was sent, so that is what shows.
    expect(await listApplications(pool, ME)).toMatchObject([{ status: 'submitted', title: 'Your response' }]);
  });

  it('lists different forms newest first', async () => {
    await saveApplications(pool, ME, [
      app({ formId: 'old', gmailMessageId: 'm1', title: 'Old', appliedAt: new Date('2026-01-01T10:00:00Z') }),
      app({ formId: 'new', gmailMessageId: 'm2', title: 'New', appliedAt: new Date('2026-09-01T10:00:00Z') }),
    ]);
    expect((await listApplications(pool, ME)).map((r) => r.title)).toEqual(['New', 'Old']);
  });

  it('notices when a form\'s link or title changes in a later copy of the same mail', async () => {
    await saveApplications(pool, ME, [app()]);
    expect(await saveApplications(pool, ME, [app({ title: 'Graduate scheme (reopened)' })])).toEqual({ added: 0, updated: 1 });
  });

  it('refuses a status it does not understand, rather than storing nonsense', async () => {
    await expect(saveApplications(pool, ME, [app({ status: 'completed' as never })])).rejects.toThrow();
  });

  it('gives someone with no applications an empty list, not an error', async () => {
    expect(await listApplications(pool, 'nobody@example.org')).toEqual([]);
  });
});

describe('remembering how far a mailbox has been read', () => {
  beforeEach(() => pool.query('TRUNCATE mail_scans'));

  it('knows nothing about a mailbox never scanned, so the first scan reads it all', async () => {
    expect(await readThrough(pool, ME)).toBeNull();
  });

  it('remembers the point reached', async () => {
    await markReadThrough(pool, ME, new Date('2026-10-01T00:00:00Z'));
    expect((await readThrough(pool, 'Owner@Example.org'))?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('never moves backwards, so a slow scan finishing late cannot undo a quicker one', async () => {
    await markReadThrough(pool, ME, new Date('2026-10-05T00:00:00Z'));
    await markReadThrough(pool, ME, new Date('2026-10-01T00:00:00Z'));
    expect((await readThrough(pool, ME))?.toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });
});

describe('scanning from where the last scan stopped', () => {
  /** A pretend mailbox that records the query it was asked. */
  const fakeMailbox = (complete = true) => {
    const asked: string[] = [];
    const mailbox: Mailbox = {
      address: async () => ME,
      search: async (q) => {
        asked.push(q);
        return { messages: [], complete };
      },
    };
    return { mailbox, asked };
  };

  it('reads everything when there is nowhere to start from', async () => {
    const { mailbox, asked } = fakeMailbox();
    await scanMailbox(mailbox, { since: null });
    expect(asked[0]).not.toContain('after:');
  });

  it('asks only for mail since the last scan, with a day of overlap', async () => {
    const { mailbox, asked } = fakeMailbox();
    const since = new Date('2026-10-05T00:00:00Z');
    await scanMailbox(mailbox, { since });
    const after = Number(asked[0].match(/after:(\d+)$/)![1]) * 1000;
    expect(since.getTime() - after).toBe(RESCAN_OVERLAP_MS);
  });

  it('passes on whether the read was complete, so the caller knows whether to move the marker', async () => {
    expect((await scanMailbox(fakeMailbox(false).mailbox)).complete).toBe(false);
    expect((await scanMailbox(fakeMailbox(true).mailbox)).complete).toBe(true);
  });
});

describe('short links across a whole scan', () => {
  const PUBLISHED = '1FAIpQLSdsw98ypAQdRyxYlr5z5ysy5EwEyiGVMEGMyF5LMINzp4pT3g';
  const long = `https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`;
  const mail = (id: string, subject: string, text: string, at: string): MailMessage => ({ id, subject, from: '', receivedAt: new Date(at), text });
  const mailboxOf = (messages: MailMessage[]): Mailbox => ({ address: async () => ME, search: async () => ({ messages, complete: true }) });
  /** forms.gle as a pretend: each code redirects to the given form, anything else is unreachable. */
  const shortener = (map: Record<string, string>) => {
    let calls = 0;
    const fetch = (async (input: string | URL | Request) => {
      calls++;
      const code = new URL(String(input)).pathname.slice(1);
      if (!map[code]) throw new TypeError('fetch failed');
      return new Response(null, { status: 302, headers: { location: map[code] } });
    }) as typeof globalThis.fetch;
    return { fetch, calls: () => calls };
  };

  const invitation = mail('invite', 'Applications open', 'Apply at https://forms.gle/applyNow1', '2026-09-01T10:00:00Z');
  const receipt = mail('receipt', 'Your response', `Edit your response: ${long}?edit2=2_ABaOnuc`, '2026-09-03T10:00:00Z');

  it('recognises an invitation by short link and a receipt by full link as one form, sent', async () => {
    const scan = await scanMailbox(mailboxOf([receipt, invitation]), { fetch: shortener({ applyNow1: long }).fetch });
    await saveApplications(pool, ME, scan.found);
    expect(await listApplications(pool, ME)).toMatchObject([{ form_id: PUBLISHED, status: 'submitted' }]);
    expect(scan).toMatchObject({ shortLinks: 1, unresolved: 0 });
  });

  it('still records a short link it cannot follow, by its code, and says how many it could not', async () => {
    const scan = await scanMailbox(mailboxOf([invitation]), { fetch: shortener({}).fetch });
    expect(scan.found).toMatchObject([{ formId: 'applyNow1', formIdKind: 'short', status: 'found' }]);
    expect(scan).toMatchObject({ shortLinks: 1, unresolved: 1 });
    // And the database accepts it, rather than the whole save failing.
    expect(await saveApplications(pool, ME, scan.found)).toEqual({ added: 1, updated: 0 });
  });

  it('follows a short link once however many messages carry it', async () => {
    const reminders = [1, 2, 3].map((n) => mail(`r${n}`, 'Reminder', 'https://forms.gle/applyNow1', `2026-09-0${n}T10:00:00Z`));
    const s = shortener({ applyNow1: long });
    await scanMailbox(mailboxOf(reminders), { fetch: s.fetch });
    expect(s.calls()).toBe(1);
  });

  it('counts a receipt carrying both a short share link and the full edit link as one sent form', async () => {
    const both = mail('m1', 'Your response', `Share: https://forms.gle/applyNow1\nEdit your response: ${long}?edit2=abc`, '2026-09-03T10:00:00Z');
    const scan = await scanMailbox(mailboxOf([both]), { fetch: shortener({ applyNow1: long }).fetch });
    expect(scan.found).toMatchObject([{ formId: PUBLISHED, status: 'submitted' }]);
  });

  it('does not reach out at all when no mail has a short link', async () => {
    const s = shortener({});
    await scanMailbox(mailboxOf([receipt]), { fetch: s.fetch });
    expect(s.calls()).toBe(0);
  });
});
