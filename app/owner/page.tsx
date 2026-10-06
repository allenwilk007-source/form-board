import { listForms, listSubmissions, recentSyncRuns, type OwnerSubmissionRow } from '../../src/lib/owner-data.ts';
import { ownerPool } from '../../src/lib/pools.ts';
import { requireOwnerPage } from '../../src/server/auth.ts';
import { SignedInBar } from '../_components/signed-in-bar.tsx';

export const dynamic = 'force-dynamic';

type Search = { q?: string; form?: string; page?: string; synced?: string; deleted?: string };
const fmt = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

function belongsTo(s: OwnerSubmissionRow) {
  if (s.deleted_at) return <span className="muted">deleted</span>;
  if (s.owner_email) return <span className="mono">{s.owner_email}</span>;
  if (s.respondent_email) return <span className="warn">nobody (typed email, not trusted)</span>;
  return <span className="warn">nobody (no email)</span>;
}

export default async function OwnerPage({ searchParams }: { searchParams: Promise<Search> }) {
  const email = await requireOwnerPage();
  const sp = await searchParams;
  const db = ownerPool();
  const [forms, list, runs] = await Promise.all([
    listForms(db),
    listSubmissions(db, { q: sp.q, formId: sp.form, page: Number(sp.page ?? 1) }),
    recentSyncRuns(db),
  ]);
  const pageLink = (page: number) => `/owner?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(sp.form ? { form: sp.form } : {}), page: String(page) })}`;

  return (
    <>
      <SignedInBar email={email} />
      <main id="main">
        <h1>Owner area</h1>
        {sp.synced && <p className={`notice ${sp.synced === 'ok' ? 'ok' : 'warn'}`} role="status">{sp.synced === 'ok' ? 'Sync finished.' : 'Sync finished with errors. See the sync log.'}</p>}
        {sp.deleted && <p className="notice ok" role="status">Submission deleted.</p>}

        <section>
          <h2>Forms</h2>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Form</th><th>State</th><th>Emails</th><th>Submissions</th></tr></thead>
              <tbody>
                {forms.map((f) => (
                  <tr key={f.id}>
                    <td>{f.title}</td>
                    <td>{f.accepting_responses ? <span className="ok">open</span> : <span className="muted">closed</span>}</td>
                    <td>{f.emails_verified ? 'verified' : <span className="warn">typed, not trusted</span>}</td>
                    <td className="num">{f.submissions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2>All submissions</h2>
          <form className="inline" method="get" action="/owner">
            <label htmlFor="q">Search<input id="q" name="q" type="search" defaultValue={sp.q ?? ''} placeholder="Answers, emails, forms" /></label>
            <label htmlFor="form">Form
              <select id="form" name="form" defaultValue={sp.form ?? ''}>
                <option value="">All forms</option>
                {forms.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
              </select>
            </label>
            <button type="submit">Show</button>
          </form>
          <p className="muted">{`${list.total} submission${list.total === 1 ? '' : 's'}${list.pages > 1 ? `, page ${list.page} of ${list.pages}` : ''}`}</p>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Sent</th><th>Form</th><th>Belongs to</th><th>Response</th></tr></thead>
              <tbody>
                {list.rows.map((s) => (
                  <tr key={s.id}>
                    <td className="num">{fmt(s.submitted_at)}</td>
                    <td><a href={`/owner/submissions/${s.id}`}>{s.form_title}</a>{s.removed_from_source_at && <span className="muted"> (deleted in Google)</span>}</td>
                    <td>{belongsTo(s)}</td>
                    <td className="mono">{s.google_response_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.pages > 1 && (
            <nav className="pages" aria-label="Pages">
              {list.page > 1 && <a href={pageLink(list.page - 1)}>← Newer</a>}
              <span className="muted">Page {list.page} of {list.pages}</span>
              {list.page < list.pages && <a href={pageLink(list.page + 1)}>Older →</a>}
            </nav>
          )}
        </section>

        <section id="sync-log">
          <form className="inline" method="post" action="/api/owner/sync">
            <h2>Sync log</h2>
            <button type="submit" className="ghost">Sync now</button>
          </form>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Started</th><th>Form</th><th>Result</th><th>Fetched</th><th>New</th><th>Changed</th><th>Removed</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="num">{fmt(r.started_at)}</td>
                    <td>{r.form_title ?? r.google_form_id}</td>
                    <td>{r.ok ? <span className="ok">ok</span> : r.ok === false ? <span className="warn">failed: {r.error}</span> : <span className="muted">running</span>}</td>
                    <td className="num">{r.fetched}</td><td className="num">{r.inserted}</td><td className="num">{r.updated}</td><td className="num">{r.removed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </>
  );
}
