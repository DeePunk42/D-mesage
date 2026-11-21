import { isDeepStrictEqual } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
export function texts(message) {
  if (typeof message?.content === 'string') return [message.content];
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((b) => b?.type === 'text' || b?.type === 'input_text')
    .map((b) => b.text);
}

export function draftPrompt(row, body) {
  const original = JSON.parse(row.request);
  function messages(q) {
    const list = q.messages ?? q.input;
    return typeof list === 'string' ? [{ role: 'user', content: list }] : list;
  }
  const wire = messages(original),
    edited = messages(body);
  if (!Array.isArray(wire) || !Array.isArray(edited) || !edited.length)
    throw Error('Select a request containing a user message.');
  let index = -1;
  for (let i = 0; i < Math.max(wire.length, edited.length); i++) {
    if (isDeepStrictEqual(wire[i], edited[i])) continue;
    if (index >= 0 || edited[i]?.role !== 'user' || (wire[i] && wire[i].role !== 'user'))
      throw Error('Edit one user message to send it to an agent.');
    index = i;
  }
  const changed = index >= 0;
  if (!changed)
    index = edited.findLastIndex(
      (m) =>
        m?.role === 'user' &&
        (typeof m.content === 'string' || m.content?.some?.((b) => b.type !== 'tool_result')),
    );
  const item = edited[index];
  if (!item) throw Error('The request has no user text.');
  if (
    Array.isArray(item.content) &&
    item.content.some((b) => !['input_text', 'text', 'tool_result'].includes(b?.type))
  )
    throw Error('This transfer supports text messages. Select a text-only user input.');
  const prompt = texts(item).join('\n');
  if (changed && Array.isArray(item.content)) {
    const before = wire[index]?.content;
    const sameShape = Array.isArray(before) && before.length === item.content.length;
    const changes = item.content.filter((b, j) => !sameShape || !isDeepStrictEqual(b, before[j]));
    if (!changes.length || changes.some((b) => !['input_text', 'text'].includes(b?.type)))
      throw Error('Edit a text block to send it to an agent.');
  }
  if (!prompt.trim()) throw Error('The user message is empty.');
  if (prompt.includes('\0'))
    throw Error('The agent cannot receive a NUL character in a background prompt.');
  return { wire, index, prompt, changed };
}
// Prefer the source's native workspace when known. Other captures share a
// dedicated directory, so a target's normal workspace trust applies across sends.
export async function newChatWorkspace(row, dataDir) {
  if (row.agent === 'codex' && /^[a-f0-9-]{36}$/i.test(row.session || '')) {
    const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
    try {
      for await (const path of new Bun.Glob('**/rollout-*-' + row.session + '.jsonl').scan({
        cwd: root,
        absolute: true,
      })) {
        const stream = createReadStream(path),
          lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            const meta = JSON.parse(line);
            if (
              meta.type === 'session_meta' &&
              meta.payload?.id === row.session &&
              meta.payload.cwd?.startsWith('/')
            )
              return meta.payload.cwd;
            break;
          }
        } finally {
          lines.close();
          stream.destroy();
        }
      }
    } catch {
      /* Local history may live on a different machine. */
    }
  }
  const cwd = resolve(dataDir, 'replay-workspace');
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}
