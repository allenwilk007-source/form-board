import { PEOPLE } from '../src/fake-google/data.ts';
import { devSignInEnabled, isOwner, ownerEmails } from '../src/lib/access.ts';
import { currentEmail } from '../src/server/auth.ts';
import { SignedInBar } from './_components/signed-in-bar.tsx';

// Placeholder home page: sign-in and who you are. Open forms and "My submissions" arrive in Phase 4.
export default async function Home() {
  const email = await currentEmail();
  if (!email) {
    const people = [...ownerEmails(), ...Object.values(PEOPLE)];
    return (
      <main>
        <h1>form-board</h1>
        {devSignInEnabled() ? (
          <section>
            <h2>Sign in as a test person</h2>
            <p className="muted">Development only. Real Google sign-in arrives at go-live.</p>
            <form className="inline" method="post" action="/api/dev-signin">
              <label htmlFor="email">
                Test person
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
          </section>
        ) : (
          <p>Sign-in with Google arrives at go-live.</p>
        )}
      </main>
    );
  }
  return (
    <>
      <SignedInBar email={email} />
      <main>
        <h1>Signed in</h1>
        <p>Your open forms and submissions will appear here in Phase 4.</p>
        {isOwner(email) && (
          <p>
            <a className="button" href="/owner">
              Open the owner area
            </a>
          </p>
        )}
      </main>
    </>
  );
}
