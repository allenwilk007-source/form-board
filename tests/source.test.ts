// Where sync reads from. Both "Sync now" and `npm run sync` go through this, so a wrong answer
// here writes fake forms into a real database, or real forms into a test one.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formsSource } from '../src/server/source.ts';

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.FORMS_SOURCE;
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_REFRESH_TOKEN = 'refresh';
});
afterEach(() => {
  process.env = { ...saved };
});

describe('formsSource', () => {
  it('reads the fake forms when nothing says otherwise', async () => {
    expect(await formsSource().listForms()).toContain('fake-form-ideas');
  });

  it('reads the fake forms when told to', async () => {
    process.env.FORMS_SOURCE = 'fake';
    expect(await formsSource().listForms()).toContain('fake-form-ideas');
  });

  it('reads the real forms when told to, without reaching Google just to be built', () => {
    process.env.FORMS_SOURCE = 'google';
    const source = formsSource();
    // The fake source answers synchronously from memory; the real one is a client that has not
    // been asked anything yet. Building it must not hit the network.
    expect(typeof source.listForms).toBe('function');
    expect(source).not.toHaveProperty('forms');
  });

  it('refuses the real forms without the approval, rather than quietly falling back to fakes', () => {
    process.env.FORMS_SOURCE = 'google';
    delete process.env.GOOGLE_REFRESH_TOKEN;
    expect(() => formsSource()).toThrow(/needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN/);
  });

  it('refuses a source it does not know, rather than guessing', () => {
    process.env.FORMS_SOURCE = 'Google';
    expect(() => formsSource()).toThrow(/Unknown FORMS_SOURCE=Google/);
  });
});
