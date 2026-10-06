// A stand-in for the Google Forms API, serving the fake forms. Tests change it (add, edit or
// delete responses and questions, or make the next call fail) to simulate what happens in Google.
import type { GoogleForm, GoogleResponse } from '../lib/google.ts';
import type { FormsSource } from '../lib/sync.ts';
import { fakeForms, fakeResponses } from './data.ts';

export type FakeSource = FormsSource & {
  forms: Map<string, GoogleForm>;
  responses: Map<string, GoogleResponse[]>;
  addResponse(formId: string, response: GoogleResponse): void;
  editResponse(formId: string, responseId: string, questionId: string, value: string, at: string): void;
  deleteResponse(formId: string, responseId: string): void;
  addQuestion(formId: string, questionId: string, title: string): void;
  renameQuestion(formId: string, questionId: string, title: string): void;
  removeQuestion(formId: string, questionId: string): void;
  setAccepting(formId: string, open: boolean): void;
  /** The next call for this form throws this error, once. */
  failNext(formId: string, message: string): void;
};

export function createFakeSource(): FakeSource {
  const forms = new Map(fakeForms.map((f) => [f.formId, structuredClone(f)]));
  const responses = new Map(Object.entries(structuredClone(fakeResponses)));
  const failures = new Map<string, string>();

  const form = (id: string) => forms.get(id) ?? fail(`Fake form ${id} not found`);
  const list = (id: string) => responses.get(id) ?? fail(`Fake form ${id} not found`);
  const maybeFail = (id: string) => {
    const message = failures.get(id);
    if (message) {
      failures.delete(id);
      throw new Error(message);
    }
  };

  return {
    forms,
    responses,
    async getForm(id) {
      maybeFail(id);
      return structuredClone(form(id));
    },
    async listResponses(id) {
      maybeFail(id);
      return structuredClone(list(id));
    },
    addResponse(id, response) {
      list(id).push(response);
    },
    editResponse(id, responseId, questionId, value, at) {
      const r = list(id).find((x) => x.responseId === responseId) ?? fail(`No response ${responseId}`);
      r.answers = { ...r.answers, [questionId]: { questionId, textAnswers: { answers: [{ value }] } } };
      r.lastSubmittedTime = at;
    },
    deleteResponse(id, responseId) {
      responses.set(id, list(id).filter((x) => x.responseId !== responseId));
    },
    addQuestion(id, questionId, title) {
      (form(id).items ??= []).push({ itemId: `i-${questionId}`, title, questionItem: { question: { questionId } } });
    },
    renameQuestion(id, questionId, title) {
      const item = form(id).items?.find((i) => i.questionItem?.question.questionId === questionId) ?? fail(`No question ${questionId}`);
      item.title = title;
    },
    removeQuestion(id, questionId) {
      const f = form(id);
      f.items = f.items?.filter((i) => i.questionItem?.question.questionId !== questionId);
    },
    setAccepting(id, open) {
      form(id).publishSettings = { publishState: { isPublished: true, isAcceptingResponses: open } };
    },
    failNext(id, message) {
      failures.set(id, message);
    },
  };
}

function fail(message: string): never {
  throw new Error(message);
}
