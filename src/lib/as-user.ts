import type pg from 'pg';

/**
 * Runs queries as one signed-in person, on the web_user connection. The email is set for this
 * transaction only (set_config(..., true)), so it can never leak to the next request that reuses
 * the pooled connection. Row-level security then limits submissions to that person's own.
 */
export async function asUser<T>(pool: pg.Pool, email: string, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('asUser needs the signed-in email address');
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.user_email', $1, true)", [email]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
