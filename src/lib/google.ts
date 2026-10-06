// The parts of the Google Forms API v1 shapes this app reads (forms.get and forms.responses.list),
// and the conversion from them into rows. Fields we don't use are left out of the types.

export type GoogleForm = {
  formId: string;
  info: { title: string };
  /** The link people use to fill in the form. */
  responderUri?: string;
  /** Absent on forms created before Google's publish settings existed. */
  publishSettings?: { publishState?: { isPublished?: boolean; isAcceptingResponses?: boolean } };
  items?: GoogleItem[];
};

type GoogleQuestion = { questionId: string; rowQuestion?: { title: string } };

export type GoogleItem = {
  itemId: string;
  title?: string;
  questionItem?: { question: GoogleQuestion };
  questionGroupItem?: { questions: GoogleQuestion[] };
};

export type GoogleResponse = {
  responseId: string;
  createTime: string;
  lastSubmittedTime: string;
  respondentEmail?: string;
  answers?: Record<
    string,
    {
      questionId: string;
      textAnswers?: { answers?: { value: string }[] };
      fileUploadAnswers?: { answers?: { fileName: string }[] };
    }
  >;
};

export type Question = { googleQuestionId: string; title: string; position: number };

export type Answer = string | string[];

export type NormalizedResponse = {
  googleResponseId: string;
  submittedAt: string;
  lastSubmittedAt: string;
  respondentEmail: string | null;
  answers: Record<string, Answer>;
};

/** Whether people can fill the form in now. A form without publish settings is treated as open. */
export function isAcceptingResponses(form: GoogleForm): boolean {
  const state = form.publishSettings?.publishState;
  if (!state) return true;
  return state.isPublished === true && state.isAcceptingResponses === true;
}

/** Every answerable question, in form order. A grid's rows become one question each, titled "Grid / Row". */
export function formQuestions(form: GoogleForm): Question[] {
  const out: Question[] = [];
  for (const item of form.items ?? []) {
    const title = item.title ?? '';
    if (item.questionItem) {
      out.push({ googleQuestionId: item.questionItem.question.questionId, title, position: out.length });
    }
    for (const row of item.questionGroupItem?.questions ?? []) {
      out.push({ googleQuestionId: row.questionId, title: `${title} / ${row.rowQuestion?.title ?? ''}`, position: out.length });
    }
  }
  return out;
}

/** One answer per question ID: a string, or a list for multi-select. File uploads keep file names only. Blank answers are left out. */
export function normalizeResponse(r: GoogleResponse): NormalizedResponse {
  const answers: Record<string, Answer> = {};
  for (const [questionId, a] of Object.entries(r.answers ?? {})) {
    const values = [
      ...(a.textAnswers?.answers ?? []).map((x) => x.value),
      ...(a.fileUploadAnswers?.answers ?? []).map((x) => x.fileName),
    ].filter((v) => v !== '');
    if (values.length === 1) answers[questionId] = values[0];
    else if (values.length > 1) answers[questionId] = values;
  }
  return {
    googleResponseId: r.responseId,
    submittedAt: r.createTime,
    lastSubmittedAt: r.lastSubmittedTime,
    respondentEmail: r.respondentEmail ?? null,
    answers,
  };
}
