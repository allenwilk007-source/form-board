import { notFound } from 'next/navigation';
import { getSubmission } from '../../../../src/lib/owner-data.ts';
import { ownerPool } from '../../../../src/lib/pools.ts';
import { requireOwnerPage } from '../../../../src/server/auth.ts';
import { SignedInBar } from '../../../_components/signed-in-bar.tsx';

export const dynamic = 'force-dynamic';

const fmt = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const val = (a: string | string[]) => (Array.isArray(a) ? a.join(', ') : a);

export default async function OwnerSubmissionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ confirm?: string }> }) {
  const email = await requireOwnerPage();
  const { id } = await params;
  const { confirm } = await searchParams;
  const s = await getSubmission(ownerPool(), id);
  if (!s) notFound();
  const known = new Set(s.questions.map((q) => q.id));
  const unknown = Object.keys(s.answers).filter((k) => !known.has(k));

  return (
    <>
      <SignedInBar email={email} />
      <main>
        <p><a href="/owner">← All submissions</a></p>
        <h1>{s.form_title}</h1>
        <dl>
          <dt>Sent</dt><dd>{fmt(s.submitted_at)}{s.last_submitted_at.getTime() !== s.submitted_at.getTime() && `, edited ${fmt(s.last_submitted_at)}`}</dd>
          <dt>Belongs to</dt><dd>{s.owner_email ?? 'nobody'}</dd>
          <dt>Email Google recorded</dt><dd>{s.respondent_email ?? 'none'}</dd>
          <dt>Google response ID</dt><dd className="mono">{s.google_response_id}</dd>
          {s.removed_from_source_at && (<><dt>Deleted in Google</dt><dd>{fmt(s.removed_from_source_at)}</dd></>)}
        </dl>

        {s.deleted_at ? (
          <p className="notice">Deleted {fmt(s.deleted_at)}. Its answers have been wiped and sync will never bring it back.</p>
        ) : (
          <>
            <section>
              <h2>Answers</h2>
              <dl>
                {s.questions.filter((q) => q.id in s.answers).map((q) => (
                  <div key={q.id} style={{ display: 'contents' }}>
                    <dt>{q.title}{q.removed && ' (question removed)'}</dt>
                    <dd>{val(s.answers[q.id])}</dd>
                  </div>
                ))}
                {unknown.map((k) => (
                  <div key={k} style={{ display: 'contents' }}><dt className="mono">{k}</dt><dd>{val(s.answers[k])}</dd></div>
                ))}
              </dl>
            </section>
            <section>
              <h2>Removal request</h2>
              {confirm ? (
                <form className="inline" method="post" action={`/api/owner/submissions/${s.id}/delete`}>
                  <p>Delete this submission for good? Its sender will no longer see it, and sync will never bring it back.</p>
                  <button type="submit" className="danger">Delete for good</button>
                  <a className="button ghost" href={`/owner/submissions/${s.id}`}>Cancel</a>
                </form>
              ) : (
                <a className="button ghost" href={`/owner/submissions/${s.id}?confirm=1`}>Delete…</a>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
