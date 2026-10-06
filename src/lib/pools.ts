import pg from 'pg';
import { requireEnv } from './db.ts';

// One pool per role for the whole server process.
let owner: pg.Pool | undefined;
let user: pg.Pool | undefined;

/** Full access: sync and the owner area only. */
export const ownerPool = () => (owner ??= new pg.Pool({ connectionString: requireEnv('DATABASE_URL'), max: 5 }));
/** Row-level-security role: everything a signed-in person sees goes through asUser on this pool. */
export const userPool = () => (user ??= new pg.Pool({ connectionString: requireEnv('USER_DATABASE_URL'), max: 5 }));
