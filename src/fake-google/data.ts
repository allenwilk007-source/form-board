// Four made-up Google Forms and their responses, in the exact shape the Forms API returns.
// Deterministic, so tests and screenshots are repeatable. No real person's data.
import type { GoogleForm, GoogleResponse } from '../lib/google.ts';

export const IDEAS_FORM_ID = 'fake-form-ideas'; // open, Verified emails
export const VOLUNTEER_FORM_ID = 'fake-form-volunteer'; // open, Verified emails
export const FEEDBACK_FORM_ID = 'fake-form-feedback'; // open, typed-in emails (not trusted)
export const HELP_FORM_ID = 'fake-form-help'; // closed, Verified emails

/** Test people. Their submissions are spread across the forms below. */
export const PEOPLE = {
  alex: 'alex.kim@example.org',
  sam: 'sam.rivera@example.org',
  jordan: 'jordan.lee@example.org',
  taylor: 'taylor.brooks@example.org',
  morgan: 'morgan.chen@example.org',
  jo: 'jo.park@example.org', // has never sent anything
} as const;
const ROTATION = [PEOPLE.sam, PEOPLE.jordan, PEOPLE.taylor, PEOPLE.morgan];

export const Q = {
  ideaTitle: 'a1000001',
  ideaDescription: 'a1000002',
  ideaCategories: 'a1000003',
  ideaName: 'a1000004',
  volName: 'c3000001',
  volDays: 'c3000002',
  volNotes: 'c3000003',
  fbRating: 'd4000001',
  fbComments: 'd4000002',
  helpTopic: 'b2000001',
  helpDetails: 'b2000002',
  helpPhone: 'b2000003',
  helpUrgency: 'b2000004', // added to the form after the 12th response
} as const;

const q = (questionId: string, title: string) => ({ itemId: `i-${questionId}`, title, questionItem: { question: { questionId } } });
const published = (open: boolean) => ({ publishState: { isPublished: true, isAcceptingResponses: open } });
const uri = (id: string) => `https://docs.google.com/forms/d/e/${id}/viewform`;

export const fakeForms: GoogleForm[] = [
  {
    formId: IDEAS_FORM_ID,
    info: { title: 'Community Project Ideas' },
    responderUri: uri(IDEAS_FORM_ID),
    publishSettings: published(true),
    items: [q(Q.ideaTitle, 'Project title'), q(Q.ideaDescription, 'Describe your idea'), q(Q.ideaCategories, 'Categories'), { itemId: 'i-break', title: 'About you' }, q(Q.ideaName, 'Your name')],
  },
  {
    formId: VOLUNTEER_FORM_ID,
    info: { title: 'Volunteer Sign-up' },
    responderUri: uri(VOLUNTEER_FORM_ID),
    publishSettings: published(true),
    items: [q(Q.volName, 'Your name'), q(Q.volDays, 'Which days can you help?'), q(Q.volNotes, 'Anything we should know?')],
  },
  {
    formId: FEEDBACK_FORM_ID,
    info: { title: 'Event Feedback' },
    responderUri: uri(FEEDBACK_FORM_ID),
    publishSettings: published(true),
    items: [q(Q.fbRating, 'How was the open day? (1–5)'), q(Q.fbComments, 'Any comments?')],
  },
  {
    formId: HELP_FORM_ID,
    info: { title: 'Help Requests' },
    responderUri: uri(HELP_FORM_ID),
    publishSettings: published(false),
    items: [q(Q.helpTopic, 'Topic'), q(Q.helpDetails, 'What do you need help with?'), q(Q.helpPhone, 'Phone number'), q(Q.helpUrgency, 'Urgency')],
  },
];

const text = (questionId: string, ...values: string[]) => ({ questionId, textAnswers: { answers: values.map((value) => ({ value })) } });
const day = (base: string, n: number, hours = 0) => new Date(Date.parse(base) + n * 864e5 + hours * 36e5).toISOString();
const pad = (n: number) => String(n).padStart(3, '0');

const TITLES = ['Tool library', 'Repair café', 'Seed swap', 'Street mural', 'Reading circle', 'Bike workshop', 'Tree planting', 'Coding club', 'Litter pick', 'Language exchange', 'Rain garden', 'Free fridge'];
const CATEGORIES = ['Environment', 'Education', 'Arts', 'Health', 'Tech'];
const TOPICS = ['Housing', 'Transport', 'Paperwork', 'Technology', 'Food'];
const DAYS = ['Saturday', 'Sunday', 'Weekday evenings'];

function ideasResponses(): GoogleResponse[] {
  return Array.from({ length: 24 }, (_, i) => {
    const t = TITLES[i % TITLES.length];
    let title = `${t} #${i + 1}`;
    let description: string | null = `A ${t.toLowerCase()} for the neighbourhood, run by volunteers. Idea number ${i + 1}.`;
    let email: string | undefined = ROTATION[i % ROTATION.length];
    if (i === 0) [title, description, email] = ['<script>alert("xss")</script> Community garden', 'Plant beds <img src=x onerror=alert(1)> and a compost bin.', PEOPLE.alex];
    if (i === 1) title = 'Café für alle ☕ — Ñandú 🌱';
    if (i === 2) description = null; // left blank
    if (i === 3) email = undefined; // sent before the form collected emails
    if (i === 4) email = 'Alex.Kim@Example.org'; // same person, different capitals
    const created = day('2026-06-01T10:00:00Z', i * 4, i % 7);
    return {
      responseId: `ideas-resp-${pad(i + 1)}`,
      createTime: created,
      lastSubmittedTime: i === 5 ? day(created, 2) : created, // edited two days later
      ...(email ? { respondentEmail: email } : {}),
      answers: {
        [Q.ideaTitle]: text(Q.ideaTitle, title),
        ...(description === null ? {} : { [Q.ideaDescription]: text(Q.ideaDescription, description) }),
        [Q.ideaCategories]: text(Q.ideaCategories, ...CATEGORIES.filter((_, c) => (i + c) % 3 === 0)),
        [Q.ideaName]: text(Q.ideaName, `Person ${i + 1}`),
      },
    };
  });
}

function volunteerResponses(): GoogleResponse[] {
  return Array.from({ length: 10 }, (_, i) => {
    const created = day('2026-09-01T09:00:00Z', i * 3, i % 4);
    return {
      responseId: `vol-resp-${pad(i + 1)}`,
      createTime: created,
      lastSubmittedTime: created,
      respondentEmail: i === 0 ? PEOPLE.sam : ROTATION[(i + 1) % ROTATION.length],
      answers: {
        [Q.volName]: text(Q.volName, `Volunteer ${i + 1}`),
        [Q.volDays]: text(Q.volDays, ...DAYS.filter((_, d) => (i + d) % 2 === 0)),
        ...(i % 3 === 0 ? { [Q.volNotes]: text(Q.volNotes, 'I can bring a van.') } : {}),
      },
    };
  });
}

function feedbackResponses(): GoogleResponse[] {
  return Array.from({ length: 8 }, (_, i) => {
    const created = day('2026-09-20T17:00:00Z', i, i % 3);
    return {
      responseId: `fb-resp-${pad(i + 1)}`,
      createTime: created,
      lastSubmittedTime: created,
      // Typed-in emails. Response 1 was sent by someone who typed Alex's address.
      respondentEmail: i === 0 ? PEOPLE.alex : ROTATION[i % ROTATION.length],
      answers: {
        [Q.fbRating]: text(Q.fbRating, String((i % 5) + 1)),
        [Q.fbComments]: text(Q.fbComments, i === 0 ? 'Written by someone pretending to be Alex.' : `Comment ${i + 1}`),
      },
    };
  });
}

function helpResponses(): GoogleResponse[] {
  return Array.from({ length: 18 }, (_, i) => {
    const created = day('2026-05-10T15:30:00Z', i * 5, i % 5);
    return {
      responseId: `help-resp-${pad(i + 1)}`,
      createTime: created,
      lastSubmittedTime: created,
      respondentEmail: i === 2 ? PEOPLE.alex : ROTATION[i % ROTATION.length],
      answers: {
        [Q.helpTopic]: text(Q.helpTopic, TOPICS[i % TOPICS.length]),
        [Q.helpDetails]: text(Q.helpDetails, `Request ${i + 1}: I need some help with ${TOPICS[i % TOPICS.length].toLowerCase()}.`),
        [Q.helpPhone]: text(Q.helpPhone, `+1 555 01${String(i + 10).padStart(2, '0')}`),
        ...(i >= 12 ? { [Q.helpUrgency]: text(Q.helpUrgency, ['Low', 'Medium', 'High'][i % 3]) } : {}),
      },
    };
  });
}

export const fakeResponses: Record<string, GoogleResponse[]> = {
  [IDEAS_FORM_ID]: ideasResponses(),
  [VOLUNTEER_FORM_ID]: volunteerResponses(),
  [FEEDBACK_FORM_ID]: feedbackResponses(),
  [HELP_FORM_ID]: helpResponses(),
};
