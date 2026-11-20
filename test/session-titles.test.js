import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionTitles } from '../session-titles.js';

test('session titles track renames, partial writes and replacement indexes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'd-message-titles-'));
  try {
    const resolve = sessionTitles({ codexHome: home, claudeHome: home });
    const id = crypto.randomUUID();
    expect(await resolve('codex', id)).toBeUndefined();
    const index = join(home, 'session_index.jsonl');
    writeFileSync(index, JSON.stringify({ id, thread_name: 'Original' }) + '\n');
    const rename = Buffer.from(JSON.stringify({ id, thread_name: '新名字' }) + '\n');
    const cut = rename.indexOf('新') + 1;
    appendFileSync(index, rename.subarray(0, cut));
    expect(await resolve('codex', id)).toBe('Original');
    appendFileSync(index, rename.subarray(cut));
    expect(await resolve('codex', id)).toBe('新名字');
    writeFileSync(index + '.new', '');
    renameSync(index + '.new', index);
    expect(await resolve('codex', id)).toBeUndefined();

    const project = join(home, 'projects', 'workspace');
    mkdirSync(project, { recursive: true });
    const transcript = join(project, id + '.jsonl');
    const record = (type, fields) => JSON.stringify({ sessionId: id, type, ...fields }) + '\n';
    writeFileSync(transcript, record('ai-title', { aiTitle: 'Generated' }));
    expect(await resolve('claude', id)).toBe('Generated');
    appendFileSync(transcript, record('custom-title', { customTitle: 'My task' }) +
      record('ai-title', { aiTitle: 'Generated again' }) +
      record('custom-title', { sessionId: 'different', customTitle: 'Another chat' }));
    expect(await resolve('claude', id)).toBe('My task');
    expect(await resolve('claude', 'missing')).toBeUndefined();
    expect(await resolve('other', id)).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
