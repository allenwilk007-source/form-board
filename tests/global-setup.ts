import { execSync } from 'node:child_process';
import { migrate } from '../src/lib/migrate.ts';
import { connect, OWNER_URL, TEST_DB } from './db.ts';

export default async function setup() {
  const admin = await connect(OWNER_URL.replace(`/${TEST_DB}`, '/postgres'));
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  const db = await connect(OWNER_URL);
  await migrate(db);
  await db.end();
  // tests/http.test.ts runs the built site
  execSync('npx next build', { stdio: 'ignore' });
}
