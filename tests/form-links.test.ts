import { describe, expect, it } from 'vitest';
import { formLinks } from '../src/lib/form-links.ts';

const PUBLISHED = '1FAIpQLSdsw98ypAQdRyxYlr5z5ysy5EwEyiGVMEGMyF5LMINzp4pT3g';
const DIRECT = '1sLls-XCt1OLH5jsti1vLGTKFEpBnbJD4-7zur51w3CY';

describe('finding forms in an email', () => {
  it('finds the published link a responder is sent', () => {
    expect(formLinks(`Thanks. https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`)).toEqual([
      { id: PUBLISHED, kind: 'published', url: `https://docs.google.com/forms/d/e/${PUBLISHED}/viewform` },
    ]);
  });

  it('finds an editing link too, and keeps the two kinds apart', () => {
    const found = formLinks(`a https://docs.google.com/forms/d/${DIRECT}/edit and b https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`);
    expect(found.map((f) => f.kind)).toEqual(['direct', 'published']);
    expect(found.map((f) => f.id)).toEqual([DIRECT, PUBLISHED]);
  });

  it('keeps the edit-response link whole, query string and all', () => {
    const url = `https://docs.google.com/forms/d/e/${PUBLISHED}/viewform?edit2=2_ABaOnucT8Xk_w`;
    expect(formLinks(`Edit your response: ${url}`)[0].url).toBe(url);
  });

  it('counts a form once however many times it is linked', () => {
    const text = `
      <a href="https://docs.google.com/forms/d/e/${PUBLISHED}/viewform">View</a>
      <a href="https://docs.google.com/forms/d/e/${PUBLISHED}/viewform?edit2=abc">Edit your response</a>
      https://docs.google.com/forms/d/e/${PUBLISHED}/viewform
    `;
    expect(formLinks(text)).toHaveLength(1);
  });

  it('finds several different forms, in the order they appear', () => {
    const other = '1FAIpQLSf_ANOTHER_FORM_ID_abcdefghijklmnop';
    const found = formLinks(`https://docs.google.com/forms/d/e/${other}/viewform then https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`);
    expect(found.map((f) => f.id)).toEqual([other, PUBLISHED]);
  });

  it('drops the punctuation a link picks up from a sentence', () => {
    expect(formLinks(`See https://docs.google.com/forms/d/e/${PUBLISHED}/viewform.`)[0].url).toBe(
      `https://docs.google.com/forms/d/e/${PUBLISHED}/viewform`,
    );
    expect(formLinks(`(https://docs.google.com/forms/d/e/${PUBLISHED}/viewform)`)[0].url).not.toContain(')');
  });

  it('copes with the HTML entities an email body arrives with', () => {
    const text = `href=&quot;https://docs.google.com/forms/d/e/${PUBLISHED}/viewform?usp=sf_link&amp;entry=1&quot;`;
    expect(formLinks(text)[0].id).toBe(PUBLISHED);
  });

  it('works whatever language the email is in, because it never reads the words', () => {
    const japanese = `ご回答ありがとうございました。https://docs.google.com/forms/d/e/${PUBLISHED}/viewform を編集できます。`;
    expect(formLinks(japanese)[0].id).toBe(PUBLISHED);
  });

  it('accepts http as well as https', () => {
    expect(formLinks(`http://docs.google.com/forms/d/e/${PUBLISHED}/viewform`)).toHaveLength(1);
  });

  it.each([
    ['nothing at all', ''],
    ['an email with no form in it', 'Your parcel is on its way. Track it at https://example.org/track/123'],
    ['a Google link that is not a form', 'https://docs.google.com/document/d/1abcdefghij/edit'],
    ['a sheet, not a form', 'https://docs.google.com/spreadsheets/d/1abcdefghij/edit'],
    ['a look-alike host', 'https://docs.google.com.evil.example/forms/d/e/abcdefghij/viewform'],
    ['a form word with no link', 'Please fill in the form at docs.google.com slash forms'],
  ])('finds nothing in %s', (_, text) => {
    expect(formLinks(text)).toEqual([]);
  });

  it('refuses an id too short to be real, so stray paths are not mistaken for forms', () => {
    expect(formLinks('https://docs.google.com/forms/d/short/edit')).toEqual([]);
  });
});
