import pg from 'pg';

// A separate database, recreated on every test run. Override for a non-default local setup.
export const TEST_DB = 'form_board_test';
export const OWNER_URL = process.env.TEST_DATABASE_URL ?? `postgres://fb_owner:fb_owner_local@localhost:5432/${TEST_DB}`;
export const PUBLIC_URL = process.env.TEST_PUBLIC_DATABASE_URL ?? `postgres://web_public:web_public_local@localhost:5432/${TEST_DB}`;

export async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}
