import pg from 'pg';
import { requireEnv } from '../src/lib/db.ts';
import { loadFieldConfig } from '../src/lib/fields.ts';
import { seedDemo } from '../src/lib/seed-demo.ts';

const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL') });
await client.connect();
try {
  const { forms, submissions } = await seedDemo(client, await loadFieldConfig());
  console.log(`Seeded ${forms} fake forms and ${submissions} fake submissions.`);
} finally {
  await client.end();
}
