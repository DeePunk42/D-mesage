import { nativeReply, nativeStream, sseData } from './native-reply.js';
import { requestEntries, validRequest, endpointFor } from './ui/protocols.js';
import { pairingWarning, messagePreview } from './ui/messages.js';
import { storage } from './store.js';

// Only client-side function declarations are supported. Each run ends at the first reply.
const chatFields = new Set(
  'model messages tools tool_choice parallel_tool_calls stream stream_options temperature top_p max_tokens max_completion_tokens stop seed n frequency_penalty presence_penalty logit_bias logprobs top_logprobs response_format reasoning_effort thinking user'.split(
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

export async function readReply(response, protocol = 'chat') {
  if (!response.ok)
    throw Error('Gateway HTTP ' + response.status + ' · ' + (await response.text()).slice(0, 2000));
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const reply = await response.json();
    if (protocol !== 'chat') return nativeReply(protocol, reply);
    if (!reply?.choices?.length || reply.error)
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
    if (chunk.error) throw Error(chunk.error.message || 'Stream error');
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

let running = false;
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
      if (running) throw Error('Wait for the current replay to finish.');
      if (!repeat?.ref.startsWith('draft:')) {
        db.query('INSERT INTO experiments(id,call_id,created,body) VALUES(?,?,?,?)').run(
          exp,
          call.id,
          started,
          JSON.stringify(body),
        );
      }
      const last = requestEntries(protocol, body).at(-1)?.message;
      db.query(
        "INSERT INTO runs(id,experiment_id,kind,started,status,owner,last_role,last_preview,tab_id,model) VALUES(?,?,'send',?,'running',?,?,?,?,?)",
      ).run(
        id,
        exp,
        started,
        process.pid,
        last?.role || '',
        messagePreview(last),
        call.tabId ?? null,
        body.model,
      );
      if (call.tabId)
        db.query('UPDATE repeater_tabs SET selected_run=? WHERE id=?').run(id, call.tabId);
      if (repeat) db.query('INSERT INTO repeat_keys VALUES(?,?,?)').run(repeat.key, repeat.ref, id);
      return id;
    })
    .immediate();
  if (accepted !== id) return accepted;
  running = true;
  void (async () => {
    try {
      const response = await fetch(destination, {
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
        body: JSON.stringify(body),
      });
      const reply = await readReply(response, protocol);
      const status =
        protocol === 'responses' && ['incomplete', 'failed'].includes(reply.status)
          ? reply.status
          : 'complete';
      db.query('UPDATE runs SET status=?,error=?,ended=?,reply=? WHERE id=?').run(
        status,
        reply.error?.message || null,
        Date.now(),
        JSON.stringify(reply),
        id,
      );
    } catch (e) {
      db.query("UPDATE runs SET status='failed',ended=?,error=? WHERE id=?").run(
        Date.now(),
        String(e.message),
        id,
      );
    } finally {
      running = false;
    }
  })().catch((e) => console.error('D-message write error:', e.name));
  return id;
}
