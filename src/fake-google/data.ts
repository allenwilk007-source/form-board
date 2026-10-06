// Two made-up Google Forms and their responses, in the exact shape the Forms API returns.
// Deterministic, so tests and screenshots are repeatable. No real person's data.
import type { GoogleForm, GoogleResponse } from '../lib/google.ts';

export const IDEAS_FORM_ID = 'fake-form-ideas';
export const HELP_FORM_ID = 'fake-form-help';

export const Q = {
  ideaTitle: 'a1000001',
  ideaDescription: 'a1000002',
  ideaCategories: 'a1000003',
  ideaName: 'a1000004',
  ideaEmail: 'a1000005',
  helpTopic: 'b2000001',
  helpDetails: 'b2000002',
  helpPhone: 'b2000003',
  helpUrgency: 'b2000004', // added to the form partway through; not in config, so private
} as const;

/** Private values planted in the data. None may ever appear in public output. */
export const KNOWN_PRIVATE_VALUES = ['private.test@example.com', 'Pat Private', 'help.private@example.com', '+1 555 0100'];

const q = (questionId: string, title: string) => ({ itemId: `i-${questionId}`, title, questionItem: { question: { questionId } } });

export const fakeForms: GoogleForm[] = [
  {
    formId: IDEAS_FORM_ID,
    info: { title: 'Community Project Ideas' },
    items: [
      q(Q.ideaTitle, 'Project title'),
      q(Q.ideaDescription, 'Describe your idea'),
      q(Q.ideaCategories, 'Categories'),
      { itemId: 'i-break', title: 'About you' }, // a page break: not a question
      q(Q.ideaName, 'Your name'),
      q(Q.ideaEmail, 'Your email'),
    ],
  },
  {
    formId: HELP_FORM_ID,
    info: { title: 'Help Requests' },
    items: [
      q(Q.helpTopic, 'Topic'),
      q(Q.helpDetails, 'What do you need help with?'),
      q(Q.helpPhone, 'Phone number'),
      q(Q.helpUrgency, 'Urgency'),
    ],
  },
];

const text = (questionId: string, ...values: string[]) => ({
  questionId,
  textAnswers: { answers: values.map((value) => ({ value })) },
});

const day = (base: string, n: number, hours = 0) => new Date(Date.parse(base) + n * 864e5 + hours * 36e5).toISOString();

const NAMES = ['Alex Kim', 'Sam Rivera', 'Jordan Lee', 'Taylor Brooks', 'Morgan Chen', 'Casey Patel', 'Riley Okafor', 'Jamie Novak'];
const TITLES = ['Tool library', 'Repair café', 'Seed swap', 'Street mural', 'Reading circle', 'Bike workshop', 'Tree planting', 'Coding club', 'Litter pick', 'Language exchange', 'Rain garden', 'Free fridge'];
const CATEGORIES = ['Environment', 'Education', 'Arts', 'Health', 'Tech'];
const TOPICS = ['Housing', 'Transport', 'Paperwork', 'Technology', 'Food'];
const URGENCY = ['Low', 'Medium', 'High'];

function ideasResponses(): GoogleResponse[] {
  return Array.from({ length: 36 }, (_, i) => {
    const name = NAMES[i % NAMES.length];
    let title = `${TITLES[i % TITLES.length]} #${i + 1}`;
    let description: string | null = `A ${TITLES[i % TITLES.length].toLowerCase()} for the neighbourhood, run by volunteers. Idea number ${i + 1}.`;
    let email = `${name.split(' ')[0].toLowerCase()}${i}@example.org`;
    let person = name;
    if (i === 0) {
      title = '<script>alert("xss")</script> Community garden';
      description = 'Plant beds <img src=x onerror=alert(1)> and a compost bin.';
    }
    if (i === 1) title = 'Café für alle ☕ — Ñandú 🌱';
    if (i === 2) [email, person] = ['private.test@example.com', 'Pat Private'];
    if (i === 3) description = null; // left blank
    const created = day('2026-03-01T10:00:00Z', i * 4, i % 7);
    return {
      responseId: `ideas-resp-${String(i + 1).padStart(3, '0')}`,
      createTime: created,
      lastSubmittedTime: created,
      answers: {
        [Q.ideaTitle]: text(Q.ideaTitle, title),
        ...(description === null ? {} : { [Q.ideaDescription]: text(Q.ideaDescription, description) }),
        [Q.ideaCategories]: text(Q.ideaCategories, ...CATEGORIES.filter((_, c) => (i + c) % 3 === 0)),
        [Q.ideaName]: text(Q.ideaName, person),
        [Q.ideaEmail]: text(Q.ideaEmail, email),
      },
    };
  });
}

function helpResponses(): GoogleResponse[] {
  return Array.from({ length: 24 }, (_, i) => {
    const created = day('2026-05-10T15:30:00Z', i * 5, i % 5);
    const edited = i === 7 ? day(created, 2) : created; // this person changed their answer two days later
    return {
      responseId: `help-resp-${String(i + 1).padStart(3, '0')}`,
      createTime: created,
      lastSubmittedTime: edited,
      respondentEmail: i === 5 ? 'help.private@example.com' : `requester${i}@example.net`,
      answers: {
        [Q.helpTopic]: text(Q.helpTopic, TOPICS[i % TOPICS.length]),
        [Q.helpDetails]: text(Q.helpDetails, i === 7 ? 'Updated: I now need help with a form in Spanish.' : `Request ${i + 1}: I need some help with ${TOPICS[i % TOPICS.length].toLowerCase()}.`),
        [Q.helpPhone]: text(Q.helpPhone, i === 5 ? '+1 555 0100' : `+1 555 01${String(i + 10).padStart(2, '0')}`),
        // "Urgency" was added to the form after the 12th response
        ...(i >= 12 ? { [Q.helpUrgency]: text(Q.helpUrgency, URGENCY[i % 3]) } : {}),
      },
    };
  });
}

export const fakeResponses: Record<string, GoogleResponse[]> = {
  [IDEAS_FORM_ID]: ideasResponses(),
  [HELP_FORM_ID]: helpResponses(),
};
