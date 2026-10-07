import { PEOPLE } from '../src/fake-google/data.ts';
import { devSignInEnabled, googleSignInEnabled, isOwner, ownerEmails } from '../src/lib/access.ts';
import { showDate } from '../src/lib/format.ts';
import { homeFor } from '../src/lib/person-data.ts';
import { userPool } from '../src/lib/pools.ts';
import { currentEmail } from '../src/server/auth.ts';
import { SignedInBar } from './_components/signed-in-bar.tsx';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<{ signin?: string }> }) {
  const email = await currentEmail();
  if (!email) return <SignIn signin={(await searchParams).signin} />;
  const { openForms, submissions } = await homeFor(userPool(), email);

  return (
    <>
      <SignedInBar email={email} />
      <main id="main">
        <h1>Your forms</h1>

        <section aria-labelledby="open-heading">
          <h2 id="open-heading">Open forms</h2>
          {openForms.length ? (
            <ul className="list">
              {openForms.map((f) => (
                <li key={f.id} className="item">
                  <div>
                    <span className="title">{f.title}</span>
                    <span className="muted">Accepting responses</span>
                  </div>
                  {f.responder_uri ? (
                    <a className="button" href={f.responder_uri} rel="noopener noreferrer" aria-label={`Fill in ${f.title} (opens Google Forms)`}>
                      Fill in
                    </a>
                  ) : (
                    <span className="muted">No link yet</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No open forms you haven&rsquo;t already sent.</p>
          )}
        </section>

        <section aria-labelledby="mine-heading">
          <h2 id="mine-heading">My submissions</h2>
          {submissions.length ? (
            <ul className="list">
              {submissions.map((s) => (
                <li key={s.id}>
                  <a className="item" href={`/submissions/${s.id}`}>
                    <div>
                      <span className="title">{s.form_title}</span>
                      <span className="muted">
                        {`Sent ${showDate(s.submitted_at)}`}
                        {s.last_submitted_at.getTime() !== s.submitted_at.getTime() ? ` · edited ${showDate(s.last_submitted_at)}` : ''}
                      </span>
                    </div>
                    {s.form_open ? <span className="chip open">Form still open</span> : <span className="chip closed">Form closed</span>}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">You haven&rsquo;t sent any of these forms yet. Forms you send with this Google account appear here within about 15 minutes.</p>
          )}
        </section>
      </main>
    </>
  );
}

/** Why the last attempt did not sign the person in. Never says which account was involved. */
const SIGNIN_PROBLEMS: Record<string, string> = {
  denied: 'Sign-in was cancelled, so you are not signed in.',
  failed: 'Google could not confirm that sign-in. Please try again.',
};

function SignIn({ signin }: { signin?: string }) {
  const people = [...ownerEmails(), ...Object.values(PEOPLE)];
  const problem = signin ? SIGNIN_PROBLEMS[signin] : undefined;
  return (
    <main id="main">
      <div className="signin">
        <h1>form-board</h1>
        <p>Your open forms, and everything you&rsquo;ve sent, in one place.</p>
        {problem && (
          <p className="notice warn" role="status">
            {problem}
          </p>
        )}
        {googleSignInEnabled() ? (
          <form method="post" action="/api/auth/google/start">
            <button type="submit">Sign in with Google</button>
          </form>
        ) : (
          <p className="notice">Sign in with Google is not set up on this site yet.</p>
        )}
        {devSignInEnabled() && (
          <>
            <form className="inline" method="post" action="/api/dev-signin">
              <label htmlFor="email">
                Sign in as a test person
                <select id="email" name="email">
                  {people.map((p) => (
                    <option key={p} value={p}>
                      {p}
                      {isOwner(p) ? ' (owner)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit">Sign in</button>
            </form>
            <p className="muted">Development only. Real people always sign in with Google.</p>
          </>
        )}
      </div>
    </main>
  );
}
