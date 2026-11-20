import { nativeReply, nativeStream, replyError, sseData } from './native-reply.js';
import { validRequest, endpointFor } from './ui/protocols.js';
import { pairingWarning, requestPreview } from './ui/messages.js';
import { finalPreview } from './ui/response-items.js';
import { storage } from './store.js';

// Only client-side function declarations are supported. Each run ends at the first reply.
const chatFields = new Set(
  'store model messages tools tool_choice parallel_tool_calls stream stream_options temperature top_p max_tokens max_completion_tokens stop seed n frequency_penalty presence_penalty logit_bias logprobs top_logprobs response_format reasoning_effort thinking user'.split(
    ' ',
  ),
);
export function validate(body, protocol = 'chat') {
  if (typeof body?.model !== 'string' || !body.model.trim()) throw Error('Select a replay model.');
  if (protocol !== 'chat') {
    if (!validRequest(protocol, body)) throw Error('Use valid native protocol input.');
    return;
  }
  if (!Array.isArray(body.messages) || !body.messages.length)
    throw Error('Use a nonempty messages array.');
  const warning = pairingWarning(body.messages);
  if (warning) throw Error(warning);
  for (const key of Object.keys(body))
    if (!chatFields.has(key)) throw Error('Unsupported replay field: ' + key);
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.some((t) => t?.type !== 'function' || !t.function?.name))
  )
    throw Error('Replay supports client-side function tools only.');
}

// Bound error bodies while reading, including plain-text proxy error pages.
async function httpError(response) {
  const reader = response.body?.getReader();
  const limit = 8192;
  const decoder = new TextDecoder();
  let size = 0, raw = '', truncated = false;
  try {
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      const take = Math.min(limit - size, value.length);
      raw += decoder.decode(value.subarray(0, take), { stream: true });
      size += take;
      if (take < value.length) {
        truncated = true;
        break;
      }
    }
  } finally {
    raw += decoder.decode();
    if (reader) void reader.cancel().catch(() => {});
  }
  let envelope;
  try { envelope = JSON.parse(raw); } catch {}
  const error = replyError(envelope, raw.trim() || response.statusText || 'Gateway request failed.');
  error.raw = raw;
  error.truncated = truncated;
  return error;
}

export async function readReply(response, protocol = 'chat') {
  if (!response.ok) throw await httpError(response);
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const reply = await response.json();
    if (protocol !== 'chat') return nativeReply(protocol, reply);
    if (reply?.error) throw replyError(reply, 'Gateway response error.');
    if (!reply?.choices?.length)
      throw Error('The gateway returned an incomplete chat response.');
    return reply;
  }
  if (protocol !== 'chat') return nativeStream(protocol, response.body);
  let done = false;
  const reply = { object: 'chat.completion', choices: [] },
    choices = new Map();
  function event(raw) {
    if (raw.trim() === '[DONE]') {
      done = true;
      return;
    }
    const chunk = JSON.parse(raw);
    if (chunk.error) throw replyError(chunk, 'Stream error');
    for (const k of ['id', 'created', 'model', 'usage', 'system_fingerprint'])
      if (chunk[k] != null) reply[k] = chunk[k];
    for (const item of chunk.choices || []) {
      let c = choices.get(item.index);
      if (!c) {
        c = {
          index: item.index,
          message: { role: 'assistant', content: null },
          finish_reason: null,
        };
        choices.set(item.index, c);
      }
      const d = item.delta || {};
      for (const k of ['content', 'reasoning_content', 'reasoning', 'refusal'])
        if (typeof d[k] === 'string') c.message[k] = (c.message[k] || '') + d[k];
      for (const t of d.tool_calls || []) {
        const all = (c.message.tool_calls ||= []);
        const target = (all[t.index] ||= {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        });
        if (t.id) target.id = t.id;
        target.function.name += t.function?.name || '';
        target.function.arguments += t.function?.arguments || '';
      }
      if (item.finish_reason != null) c.finish_reason = item.finish_reason;
      if (item.logprobs) {
        c.logprobs ||= {};
        for (const [key, values] of Object.entries(item.logprobs))
          if (Array.isArray(values)) (c.logprobs[key] ||= []).push(...values);
      }
    }
  }
  for await (const raw of sseData(response.body)) {
    event(raw);
    if (done) break;
  }
  reply.choices = [...choices.values()].sort((a, b) => a.index - b.index);
  if (!done || !reply.choices.length || reply.choices.some((c) => c.finish_reason == null))
    throw Error('Stream interrupted before the completion event.');
  return reply;
}

const concurrency = 8;
const queueLimit = 128;

export function launch(call, body, upstream, repeat) {
  const protocol = call.protocol || 'chat';
  validate(body, protocol);
  if (!call.tabId && body.model !== call.model) throw Error('Use the source snapshot model.');
  const destination =
    protocol === 'chat' ? upstream : new URL(endpointFor(protocol, call.endpoint), upstream);
  const db = storage(),
    id = crypto.randomUUID(),
    exp = repeat?.ref.startsWith('draft:') ? repeat.ref.slice(6) : crypto.randomUUID(),
    started = Date.now();
  const accepted = db
    .transaction(() => {
      if (repeat) {
        const existing = db
          .query('SELECT source_ref,run_id FROM repeat_keys WHERE request_key=?')
          .get(repeat.key);
        if (existing) {
          if (existing.source_ref !== repeat.ref)
            throw Error('This request_key belongs to another snapshot.');
          return existing.run_id;
        }
      }
      if (
        call.tabId &&
        !db
          .query(
            'SELECT 1 FROM repeater_tabs WHERE id=? AND call_id=? AND revision=? AND closed IS NULL',
          )
          .get(call.tabId, call.id, call.revision)
      )
        throw Error('Draft changed or tab closed. Reopen the tab before sending.');
      if (
        db.query('SELECT count(*) AS n FROM replay_jobs WHERE owner IS NULL').get().n >= queueLimit
      )
        throw Error('Replay queue is full. Try again after a run starts.');
      if (!repeat?.ref.startsWith('draft:')) {
        db.query('INSERT INTO experiments(id,call_id,created,body) VALUES(?,?,?,?)').run(
          exp,
          call.id,
          started,
          JSON.stringify(body),
        );
      }
      const last = requestPreview(protocol, body);
      db.query(
        "INSERT INTO runs(id,experiment_id,kind,started,status,owner,last_role,last_preview,tab_id,model,preview_version) VALUES(?,?,'send',?,'queued',?,?,?,?,?,1)",
      ).run(
        id,
        exp,
        started,
        process.pid,
        last.role,
        last.text,
        call.tabId ?? null,
        body.model,
      );
      db.query('INSERT INTO replay_jobs(run_id,destination) VALUES(?,?)').run(
        id,
        String(destination),
      );
      if (call.tabId)
        db.query('UPDATE repeater_tabs SET selected_run=? WHERE id=?').run(id, call.tabId);
      if (repeat) db.query('INSERT INTO repeat_keys VALUES(?,?,?)').run(repeat.key, repeat.ref, id);
      return id;
    })
    .immediate();
  drainReplays(db);
  return accepted;
}

export function cancelQueuedRun(db, id) {
  return db
    .transaction(() => {
      if (!db.query('DELETE FROM replay_jobs WHERE run_id=? AND owner IS NULL').run(id).changes)
        throw Error('Only a queued replay can be canceled.');
      db.query("UPDATE runs SET status='canceled',ended=? WHERE id=?").run(Date.now(), id);
      return { id, status: 'canceled' };
    })
    .immediate();
}

export function drainReplays(db) {
  if (!db.query('SELECT 1 FROM replay_jobs WHERE owner IS NULL LIMIT 1').get()) return;
  // A new Magpie host can overlap its predecessor. Claim the oldest jobs and
  // count occupied slots in the same write transaction across both hosts.
  const jobs = db
    .transaction(() => {
      const busy = db
        .query('SELECT count(*) AS n FROM replay_jobs WHERE owner IS NOT NULL')
        .get().n;
      if (busy >= concurrency) return [];
      const jobs = db
        .query(
          `SELECT j.run_id AS id,j.destination,c.protocol,e.id AS experiment
      FROM replay_jobs j JOIN runs r ON r.id=j.run_id
      JOIN experiments e ON e.id=r.experiment_id JOIN calls c ON c.id=e.call_id
      WHERE j.owner IS NULL ORDER BY j.rowid LIMIT ?`,
        )
        .all(concurrency - busy);
      for (const job of jobs) {
        db.query('UPDATE replay_jobs SET owner=? WHERE run_id=?').run(process.pid, job.id);
        db.query("UPDATE runs SET status='running',owner=? WHERE id=?").run(process.pid, job.id);
      }
      return jobs;
    })
    .immediate();
  for (const job of jobs)
    executeReplay(db, job).catch((error) =>
      console.error('D-message replay worker:', error.message),
    );
}

async function executeReplay(db, { id, destination, protocol, experiment }) {
  let status, response, reply, error, failure;
  try {
    const { body } = db.query('SELECT body FROM experiments WHERE id=?').get(experiment);
    response = await fetch(destination, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(300000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer magpie-d-message',
        ...(protocol === 'anthropic'
          ? { 'x-api-key': 'magpie-d-message', 'anthropic-version': '2023-06-01' }
          : {}),
        'User-Agent': 'd-message/1',
        'X-Magpie-Session': 'replay-' + id,
      },
      body,
    });
    reply = await readReply(response, protocol);
    status =
      protocol === 'responses' && ['incomplete', 'failed'].includes(reply.status)
        ? reply.status
        : 'complete';
    if (status === 'failed') throw replyError(reply, 'The model reported a failed response.');
    error = reply.error?.message;
  } catch (e) {
    status = 'failed';
    const envelope = e.envelope;
    const detail = envelope?.error ?? envelope;
    const value = (v) => ['string', 'number'].includes(typeof v) ? String(v).slice(0, 1024) : undefined;
    const message = (e.message || String(e)).slice(0, 8192);
    failure = {
      message,
      http: response?.status,
      code: value(detail?.code ?? e.cause?.code ?? (typeof e.code === 'string' ? e.code : undefined)),
      type: value(detail?.type ?? (!response && e.name !== 'Error' ? e.name : undefined)),
      requestId: value(response?.headers.get('x-request-id') || response?.headers.get('request-id') || envelope?.request_id),
      retryAfter: value(response?.headers.get('retry-after')),
      raw: e.raw || undefined,
      truncated: e.truncated || undefined,
    };
    error = response && !response.ok ? 'Gateway HTTP ' + response.status + ' · ' + message : message;
  }
  db.transaction(() => {
    db.query('UPDATE runs SET status=?,error=?,failure=?,ended=?,reply=?,final_preview=? WHERE id=?').run(
      status,
      error ?? null,
      failure ? JSON.stringify(failure) : null,
      Date.now(),
      reply == null ? null : JSON.stringify(reply),
      finalPreview(reply),
      id,
    );
    db.query('DELETE FROM replay_jobs WHERE run_id=?').run(id);
  }).immediate();
  drainReplays(db);
}
