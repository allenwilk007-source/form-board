import { notFound, unauthorized } from 'next/navigation';
import { showAnswer, showDate } from '../../../src/lib/format.ts';
import { mySubmission } from '../../../src/lib/person-data.ts';
import { userPool } from '../../../src/lib/pools.ts';
import { currentEmail } from '../../../src/server/auth.ts';
import { SignedInBar } from '../../_components/signed-in-bar.tsx';

export const dynamic = 'force-dynamic';

export default async function SubmissionPage({ params }: { params: Promise<{ id: string }> }) {
  const email = await currentEmail();
  if (!email) unauthorized();
  const { id } = await params;
  // Someone else's submission is "not found", the same as one that doesn't exist.
  const s = await mySubmission(userPool(), email, id);
  if (!s) notFound();
  const answered = s.questions.filter((q) => q.id in s.answers);

  return (
    <>
      <SignedInBar email={email} />
      <main id="main">
        <p>
          <a href="/">← Your forms</a>
        </p>
        <div style={{ display: 'grid', gap: 6 }}>
          <h1>{s.form_title}</h1>
          <p className="muted">
            {`Sent ${showDate(s.submitted_at)}`}
            {s.last_submitted_at.getTime() !== s.submitted_at.getTime() ? `, last edited ${showDate(s.last_submitted_at)}` : ''}
          </p>
        </div>
        <section aria-labelledby="answers-heading">
          <h2 id="answers-heading">Your answers</h2>
          {answered.length ? (
            <dl className="answers">
              {answered.map((q) => (
                <div key={q.id} style={{ display: 'contents' }}>
                  <dt>{q.title}</dt>
                  <dd>{showAnswer(s.answers[q.id])}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="empty">No answers recorded.</p>
          )}
        </section>
        <p className="notice">
          {s.form_open
            ? 'These answers can’t be changed here. If this form allows editing, change them in Google Forms; this page updates after the next sync.'
            : 'These answers can’t be changed. This form is closed.'}
        </p>
      </main>
    </>
  );
}
