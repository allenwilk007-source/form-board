import pg from 'pg';

/** Anything with pg's query method: a Pool, a Client or a checked-out PoolClient. */
export type Queryable = Pick<pg.Pool, 'query'>;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}
