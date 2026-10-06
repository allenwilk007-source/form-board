import { deleteSubmission } from '../../../../../../src/lib/owner-data.ts';
import { ownerPool } from '../../../../../../src/lib/pools.ts';
import { ownerActionRefusal, seeOther } from '../../../../../../src/server/auth.ts';

/** Removal request: wipes the submission's content for good. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const refusal = await ownerActionRefusal(req);
  if (refusal) return refusal;
  const { id } = await ctx.params;
  const deleted = await deleteSubmission(ownerPool(), id);
  return seeOther(req, deleted ? '/owner?deleted=1' : `/owner/submissions/${encodeURIComponent(id)}`);
}
