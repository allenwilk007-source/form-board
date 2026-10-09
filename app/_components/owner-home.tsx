import { listApplications, readThrough, type ApplicationRow } from '../../src/lib/applications.ts';
import { EDIT_RESPONSE, safeFormHref } from '../../src/lib/form-links.ts';
import { showDate } from '../../src/lib/format.ts';
import { madeForms, type MadeForm } from '../../src/lib/owner-data.ts';
import { ownerPool } from '../../src/lib/pools.ts';

/**
 * The owner's home: the forms they made beside the forms they applied to. Only ever rendered after
 * isOwner() has passed — the second column is read from the owner's own mailbox, so it must never
 * reach anybody else.
 */
export async function OwnerHome({ email }: { email: string }) {
  const db = ownerPool();
  const [made, applied, readUpTo] = await Promise.all([madeForms(db), listApplications(db, email), readThrough(db, email)]);

  return (
    <main id="main" className="wide">
      <h1>Your forms</h1>
      <div className="split">
        <section aria-labelledby="made-heading">
          <h2 id="made-heading">Forms you made</h2>
          <p className="muted">Your open Google Forms, and closed ones changed in the last 60 days.</p>
          {made.length ? (
            <ul className="list">
              {made.map((f) => (
                <MadeItem key={f.id} form={f} />
              ))}
            </ul>
          ) : (
            <p className="empty">No forms yet. They appear here after the next sync.</p>
          )}
        </section>

        <section aria-labelledby="applied-heading">
          <h2 id="applied-heading">Forms you applied to</h2>
          <p className="muted">
            Found in your Gmail. <strong>Submitted</strong> means Google&rsquo;s copy of your response arrived;{' '}
            <strong>Received</strong> means the form reached your inbox, and whether you sent it can&rsquo;t be told.
          </p>
          {readUpTo && <p className="muted">{`Inbox read up to ${showDate(readUpTo)}.`}</p>}
          {applied.length ? (
            <ul className="list">
              {applied.map((a) => (
                <AppliedItem key={a.id} application={a} />
              ))}
            </ul>
          ) : readUpTo ? (
            <p className="empty">Nothing in your inbox links to a Google Form.</p>
          ) : (
            <p className="empty">
              Your inbox hasn&rsquo;t been read yet. Add Gmail access, then run <span className="mono">npm run gmail:scan</span> (see
              the README).
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

function MadeItem({ form }: { form: MadeForm }) {
  const fillIn = form.accepting_responses && form.responder_uri ? safeFormHref(form.responder_uri) : null;
  return (
    <li className="item">
      <div>
        <span className="title">{form.title}</span>
        <span className="meta">
          {form.accepting_responses ? <span className="chip open">Open</span> : <span className="chip closed">Closed</span>}
          <span className="muted">{`${form.submissions} ${form.submissions === 1 ? 'response' : 'responses'}`}</span>
        </span>
        {!form.emails_verified && (
          <span className="warn">Not collecting verified emails, so responses can&rsquo;t be shown to the people who sent them.</span>
        )}
      </div>
      <span className="actions">
        {/* Accessible names start with the visible words, so "click Open form" works by voice too. */}
        <a href={`/owner?form=${encodeURIComponent(form.id)}`} aria-label={`Responses to ${form.title}`}>
          Responses
        </a>
        {fillIn && (
          <a href={fillIn} rel="noopener noreferrer" aria-label={`Open form: ${form.title} (opens Google Forms)`}>
            Open form
          </a>
        )}
      </span>
    </li>
  );
}

function AppliedItem({ application: a }: { application: ApplicationRow }) {
  const href = safeFormHref(a.link);
  const sent = a.status === 'submitted';
  // The edit-your-response link takes them to their own answers; anything else to the blank form.
  const label = sent && EDIT_RESPONSE.test(a.link) ? 'Your response' : 'Open form';
  return (
    <li className="item">
      <div>
        <span className="title">{a.title}</span>
        <span className="meta">
          {sent ? <span className="chip open">Submitted</span> : <span className="chip closed">Received</span>}
          <span className="muted">{showDate(a.applied_at)}</span>
        </span>
      </div>
      {href && (
        <a href={href} rel="noopener noreferrer" aria-label={`${label}: ${a.title} (opens Google Forms)`}>
          {label}
        </a>
      )}
    </li>
  );
}
