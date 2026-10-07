// Storing what a mailbox scan found, against the real database.
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listApplications, saveApplications, type Application } from '../src/lib/applications.ts';
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
