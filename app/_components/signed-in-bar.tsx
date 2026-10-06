import { isOwner } from '../../src/lib/access.ts';

export function SignedInBar({ email }: { email: string }) {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="bar">
        <a className="brand" href="/">
          form-board
        </a>
        <nav aria-label="Account">
          {isOwner(email) && <a href="/owner">Owner area</a>}
          <span className="who">Signed in as {email}</span>
          <form method="post" action="/api/signout">
            <button className="ghost" type="submit">
              Sign out
            </button>
          </form>
        </nav>
      </header>
    </>
  );
}
