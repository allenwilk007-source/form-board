import { readFile } from 'node:fs/promises';
import type { Queryable } from './db.ts';

export type FieldConfig = { forms: Record<string, { public: { id: string; label: string }[] }> };

const CONFIG_PATH = new URL('../../config/fields.json', import.meta.url);

/** Checks the shape strictly: a malformed config must stop sync, never quietly change what is public. */
export function parseFieldConfig(raw: unknown): FieldConfig {
  const fail = (why: string): never => {
    throw new Error(`config/fields.json is invalid: ${why}`);
  };
  if (typeof raw !== 'object' || raw === null) fail('not an object');
  const forms = (raw as { forms?: unknown }).forms;
  if (typeof forms !== 'object' || forms === null || Array.isArray(forms)) fail('"forms" must be an object');
  for (const [formId, entry] of Object.entries(forms as object)) {
    const list = (entry as { public?: unknown })?.public;
    if (!Array.isArray(list)) fail(`"${formId}.public" must be a list`);
    for (const f of list as unknown[]) {
      const { id, label } = (f ?? {}) as { id?: unknown; label?: unknown };
      if (typeof id !== 'string' || id === '' || typeof label !== 'string') fail(`"${formId}.public" entries need a string "id" and "label"`);
    }
  }
  return raw as FieldConfig;
}

export async function loadFieldConfig(): Promise<FieldConfig> {
  return parseFieldConfig(JSON.parse(await readFile(CONFIG_PATH, 'utf8')));
}

/** Sets questions.is_public from the config, for one form or all of them. Unlisted questions and forms become private. */
export async function applyFieldConfig(db: Queryable, config: FieldConfig, onlyFormId?: string): Promise<void> {
  const { rows: forms } = await db.query<{ id: string; google_form_id: string }>(
    'SELECT id, google_form_id FROM forms WHERE $1::bigint IS NULL OR id = $1',
    [onlyFormId ?? null],
  );
  for (const form of forms) {
    const publicIds = config.forms[form.google_form_id]?.public.map((f) => f.id) ?? [];
    await db.query('UPDATE questions SET is_public = (google_question_id = ANY($2::text[])) WHERE form_id = $1', [form.id, publicIds]);
  }
}
