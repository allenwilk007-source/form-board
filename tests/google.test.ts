import { describe, expect, it } from 'vitest';
import { formQuestions, normalizeResponse, type GoogleResponse } from '../src/lib/google.ts';

describe('formQuestions', () => {
  it('lists questions in order, skips non-questions and splits grid rows', () => {
    const questions = formQuestions({
      formId: 'f',
      info: { title: 'T' },
      items: [
        { itemId: '1', title: 'Name', questionItem: { question: { questionId: 'q1' } } },
        { itemId: '2', title: 'Page two' },
        {
          itemId: '3',
          title: 'Rate us',
          questionGroupItem: { questions: [{ questionId: 'r1', rowQuestion: { title: 'Speed' } }, { questionId: 'r2', rowQuestion: { title: 'Quality' } }] },
        },
      ],
    });
    expect(questions).toEqual([
      { googleQuestionId: 'q1', title: 'Name', position: 0 },
      { googleQuestionId: 'r1', title: 'Rate us / Speed', position: 1 },
      { googleQuestionId: 'r2', title: 'Rate us / Quality', position: 2 },
    ]);
  });

  it('handles a form with no items', () => {
    expect(formQuestions({ formId: 'f', info: { title: 'Empty' } })).toEqual([]);
  });
});

describe('normalizeResponse', () => {
  const base: GoogleResponse = { responseId: 'r1', createTime: '2026-01-01T00:00:00Z', lastSubmittedTime: '2026-01-02T00:00:00Z' };

  it('keeps one value as a string, several as a list, file uploads as names, and drops blanks', () => {
    const r = normalizeResponse({
      ...base,
      respondentEmail: 'a@example.com',
      answers: {
        one: { questionId: 'one', textAnswers: { answers: [{ value: 'Yes' }] } },
        many: { questionId: 'many', textAnswers: { answers: [{ value: 'A' }, { value: 'C' }] } },
        file: { questionId: 'file', fileUploadAnswers: { answers: [{ fileName: 'cv.pdf' }] } },
        blank: { questionId: 'blank', textAnswers: { answers: [{ value: '' }] } },
        none: { questionId: 'none' },
      },
    });
    expect(r).toEqual({
      googleResponseId: 'r1',
      submittedAt: '2026-01-01T00:00:00Z',
      lastSubmittedAt: '2026-01-02T00:00:00Z',
      respondentEmail: 'a@example.com',
      answers: { one: 'Yes', many: ['A', 'C'], file: 'cv.pdf' },
    });
  });

  it('handles a response with no answers and no email', () => {
    expect(normalizeResponse(base)).toMatchObject({ respondentEmail: null, answers: {} });
  });
});
