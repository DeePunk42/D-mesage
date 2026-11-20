import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const threadId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const outputTypes = new Set(['reasoning', 'mcp_list_tools', 'mcp_approval_request']);
function modelOutput(item) {
  return item?.type === 'message'
    ? item.role === 'assistant'
    : typeof item?.type === 'string' &&
        (outputTypes.has(item.type) || item.type.endsWith('_call'));
}

async function readOutput(file, session, responseId, started, ended) {
  const input = createReadStream(file);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const items = [];
  let verifiedThread = false;
  try {
    for await (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        if (items.length) return [];
        continue;
      }
      if (event.type === 'session_meta') {
        if (event.payload?.id !== session) return [];
        verifiedThread = true;
      }
      const time = Date.parse(event.timestamp);
      if (!verifiedThread || !Number.isFinite(time) || time < started) continue;
      if (time > ended + 2000) return [];
      const payload = event.payload;
      if (event.type === 'token_usage_record' && payload?.thread_id === session) {
        if (payload.response_id === responseId) return items;
        // A second completion inside the capture window makes preceding items ambiguous.
        if (items.length) return [];
      }
      if (time <= ended && event.type === 'response_item' && modelOutput(payload)) {
        const { internal_chat_message_metadata_passthrough: _, ...item } = payload;
        items.push(item);
      }
    }
    return [];
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function recoverCodexOutput(call, home = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  if (call.agent !== 'codex' || call.protocol !== 'responses' || call.status !== 'complete' ||
      !threadId.test(call.session) || !call.reply || call.ended == null) return [];
  const reply = JSON.parse(call.reply);
  if (!Array.isArray(reply?.output) || reply.output.length || !(reply.usage?.output_tokens > 0) ||
      typeof reply.id !== 'string' || !reply.id) return [];
  try {
    const names = new Bun.Glob(`**/rollout-*-${call.session}.jsonl`);
    let file;
    for await (const match of names.scan({ cwd: join(home, 'sessions'), absolute: true })) {
      if (file) return [];
      file = match;
    }
    if (file) return await readOutput(file, call.session, reply.id, call.started, call.ended);
  } catch {
    // The capture is still available when the client log is missing or has moved.
  }
  return [];
}
