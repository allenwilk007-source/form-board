export function SignedInBar({ email }: { email: string }) {
  return (
    <header className="bar">
      <a href="/">
        <b>form-board</b>
      </a>
      <form className="inline" method="post" action="/api/signout">
        <span className="muted">Signed in as {email}</span>
        <button className="ghost" type="submit">
          Sign out
        </button>
      </form>
    </header>
  );
}
