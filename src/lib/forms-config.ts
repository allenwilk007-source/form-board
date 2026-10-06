import { readFile } from 'node:fs/promises';

/** Which Google Forms to sync, and whether each collects Verified emails (so its emails can be trusted). */
export type FormsConfig = { forms: Record<string, { emailsVerified: boolean }> };

const CONFIG_PATH = new URL('../../config/forms.json', import.meta.url);

/** Checks the shape strictly: a malformed config must stop sync, never quietly trust emails it shouldn't. */
export function parseFormsConfig(raw: unknown): FormsConfig {
  const fail = (why: string): never => {
    throw new Error(`config/forms.json is invalid: ${why}`);
  };
  if (typeof raw !== 'object' || raw === null) fail('not an object');
  const forms = (raw as { forms?: unknown }).forms;
  if (typeof forms !== 'object' || forms === null || Array.isArray(forms)) fail('"forms" must be an object');
  for (const [formId, entry] of Object.entries(forms as object)) {
    if (formId === '') fail('a form ID is empty');
    if (typeof (entry as { emailsVerified?: unknown })?.emailsVerified !== 'boolean') fail(`"${formId}.emailsVerified" must be true or false`);
  }
  return raw as FormsConfig;
}

export async function loadFormsConfig(): Promise<FormsConfig> {
  return parseFormsConfig(JSON.parse(await readFile(CONFIG_PATH, 'utf8')));
}
