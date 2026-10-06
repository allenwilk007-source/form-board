import { ownerPool } from '../../../../src/lib/pools.ts';
import { syncAll } from '../../../../src/lib/sync.ts';
import { ownerActionRefusal, seeOther } from '../../../../src/server/auth.ts';
import { formsSource } from '../../../../src/server/source.ts';

/** "Sync now" in the owner area. Every run is logged in sync_runs, so the result shows in the sync log. */
export async function POST(req: Request) {
  const refusal = await ownerActionRefusal(req);
  if (refusal) return refusal;
  const results = await syncAll(ownerPool(), formsSource());
  return seeOther(req, `/owner?synced=${results.every((r) => r.ok) ? 'ok' : 'failed'}#sync-log`);
}
