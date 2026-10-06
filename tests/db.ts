import pg from 'pg';

// A separate database, recreated on every test run. Override for a non-default local setup.
export const TEST_DB = 'form_board_test';
export const OWNER_URL = process.env.TEST_DATABASE_URL ?? `postgres://fb_owner:fb_owner_local@localhost:5432/${TEST_DB}`;
export const USER_URL = process.env.TEST_USER_DATABASE_URL ?? `postgres://web_user:web_user_local@localhost:5432/${TEST_DB}`;

export async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}
