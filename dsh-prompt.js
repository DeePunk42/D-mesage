import { draftPrompt } from './agent-prompt.js';
// A user-authored event anchors the fork. Any edited user-role text, including
// context supplied by DSH, can be the new prompt on that branch.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

function textParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (
    Array.isArray(content) &&
    content.length &&
    content.every((b) => b?.type === 'text' && typeof b.text === 'string')
  )
    return content.map(({ text }) => ({ type: 'text', text }));
  return null;
}
const joined = (parts) => parts?.map((b) => b.text).join('');

// r.body is the request being sent. source_reply is
// the original trace reply, used only as a receipt for locating its native turn.
export function editedDshPrompt(r) {
  if (r.agent !== 'dsh') throw Error('Select a trace captured from DeepSeek Harness.');
  const original = JSON.parse(r.request).messages;
  const edited = JSON.parse(r.body).messages;
  if (!Array.isArray(original) || !Array.isArray(edited) || original.length !== edited.length)
    throw Error('Edit the text of one existing user message to resend it in DSH.');
  let change;
  for (let i = 0; i < edited.length; i++) {
    if (isDeepStrictEqual(edited[i], original[i])) continue;
    const before = textParts(original[i].content);
    const after = textParts(edited[i].content);
    if (
      change ||
      original[i].role !== 'user' ||
      edited[i].role !== 'user' ||
      !before ||
      !joined(after)?.trim() ||
      !isDeepStrictEqual({ ...original[i], content: null }, { ...edited[i], content: null })
    )
      throw Error('DSH can resend one edited user text from this request.');
    change = { index: i, before: joined(before), after };
  }
  const reply = JSON.parse(r.source_reply || 'null');
  const message = reply?.choices?.[0]?.message;
  const blocks = reply?.content;
  const text = message
    ? joined(textParts(message.content)) || ''
    : Array.isArray(blocks)
      ? blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
      : '';
  const tools = message
    ? (message.tool_calls || []).map((c) => c.id)
    : Array.isArray(blocks)
      ? blocks.filter((b) => b.type === 'tool_use').map((b) => b.id)
      : [];
  const inputs = original.map((m) => (m.role === 'user' ? joined(textParts(m.content)) : null));
  return { change, inputs, text, tools, started: r.source_started };
}

// Repeated wire text can belong to different turns. Use its occurrence in the
// request when the native log and request contain the same number of copies.
function ownerAt(inputs, index, owners) {
  const occurrences = inputs.flatMap((text, i) => (text === inputs[index] ? [i] : []));
  if (occurrences.length === owners.length) return owners[occurrences.indexOf(index)];
  if (occurrences.length === 1 && owners.length && owners.every((owner) => owner === owners[0]))
    return owners[0];
}

function promptAtCapture(plan, prompts, editedOwners) {
  let target = prompts.at(-1);
  if (plan.change) {
    let index = plan.change.index;
    let owners = editedOwners;
    // Some adapters insert context directly into the request. Anchor such a
    // block at the closest preceding user-authored input in the wire history.
    while (!owners.length && index > 0) {
      index--;
      if (plan.inputs[index] != null) owners = prompts.filter((p) => p.text === plan.inputs[index]);
    }
    target = ownerAt(plan.inputs, index, owners);
  }
  if (
    !target ||
    (!plan.change && (!target.parts || !target.text.trim() || !plan.inputs.includes(target.text)))
  )
    return {
      error:
        'Found the DSH reply, but could not uniquely identify the original user message in this request.',
    };
  if (!target.safe)
    return {
      error:
        'Found the DSH user message, but its history has no safe fork point before it was queued.',
    };
  return { atSeq: target.atSeq, content: plan.change?.after || target.parts };
}

async function matchFile(path, plan) {
  // Bun's node:zlib stream stops after the first frame of a DSH log.
  const compressed = path.endsWith('.zstd');
  const zstd =
    compressed &&
    Bun.which('zstd', {
      PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].join(':'),
    });
  const reader = zstd
    ? Bun.spawn([zstd, '-qdc', '--', path], { stdout: 'pipe', stderr: 'ignore' })
    : null;
  const stream = reader
    ? Readable.fromWeb(reader.stdout)
    : compressed
      ? Readable.from([Bun.zstdDecompressSync(await Bun.file(path).bytes())])
      : createReadStream(path);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId,
    turnEnd = -1;
  let inTurn = false;
  // A canceled/pending capture may have no reply receipt. Match its timestamp
  // inside a native step and verify the user input in that step's request.
  const timeMatch = !plan.text && !plan.tools.length && Number.isFinite(plan.started);
  let stepTime, pointAtStart;
  const prompts = [],
    matches = [],
    queued = new Map(),
    editedOwners = [];
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const { type, seq, data, id, time } = JSON.parse(line);
      if (type === 'session') sessionId = id;
      if (type === 'turn/start') inTurn = true;
      if (type === 'turn/end') {
        turnEnd = seq;
        inTurn = false;
      }
      // A restored session can have ordinary end-seed markers after its own
      // replies. Only a fork's inherited marker identifies copied receipts.
      if (type === 'session/end-seed' && data?.inherited === true) {
        matches.length = 0;
        pointAtStart = null;
      }
      if (type === 'agent/inbox/spliced') {
        for (const input of data.inserted || []) {
          if (input.source?.kind === 'user' && input.id) queued.set(input.id, inTurn ? -1 : seq);
        }
      }
      if (type === 'user/message') {
        const parts = textParts(data.content);
        const text = joined(parts);
        if (data.source?.kind === 'user') {
          const queuedAt = queued.get(data.id);
          // Cut before enqueue, so the original message cannot be drained again.
          const atSeq = queuedAt === undefined ? turnEnd : queuedAt - 1;
          prompts.push({ text, parts, atSeq, safe: atSeq >= 0 && atSeq >= turnEnd });
        }
        if (plan.change && text === plan.change.before) editedOwners.push(prompts.at(-1));
      }
      if (timeMatch) {
        if (type === 'step/start') {
          stepTime = time;
          pointAtStart = null;
        }
        if (
          Number.isFinite(stepTime) &&
          stepTime <= plan.started &&
          time <= plan.started &&
          (type === 'user/message' || type === 'step/start')
        ) {
          pointAtStart = plan.inputs.includes(prompts.at(-1)?.text)
            ? promptAtCapture(plan, prompts, editedOwners)
            : null;
        }
        if (type === 'step/end' || type === 'turn/end') {
          if (pointAtStart && time >= plan.started) matches.push({ sessionId, ...pointAtStart });
          stepTime = pointAtStart = null;
        }
        continue;
      }
      if (type !== 'assistant/message') continue;
      const content = data.message.content;
      if (!Array.isArray(content)) continue;
      if (
        content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('') !== plan.text ||
        !isDeepStrictEqual(
          content.filter((b) => b.type === 'tool-call').map((b) => b.id),
          plan.tools,
        )
      )
        continue;
      matches.push({ sessionId, ...promptAtCapture(plan, prompts, editedOwners) });
    }
  } finally {
    lines.close();
    stream.destroy();
    if (reader && (await reader.exited) !== 0)
      throw Error('Could not read the compressed DSH session log.');
  }
  if (timeMatch && pointAtStart) matches.push({ sessionId, ...pointAtStart });
  return matches;
}

export async function locateDshPrompt(
  r,
  root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions'),
) {
  const plan = editedDshPrompt(r);
  const matches = [];
  for (const group of await readdir(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const dir = join(root, group.name);
    for (const session of await readdir(dir, { withFileTypes: true })) {
      if (
        !session.isDirectory() ||
        (r.session?.startsWith('session-') && r.session !== session.name)
      )
        continue;
      const folder = join(dir, session.name);
      const names = await readdir(folder);
      const name = ['session.v4.jsonl.zstd', 'session.v4.jsonl'].find((n) => names.includes(n));
      if (!name) continue;
      const file = join(folder, name);
      if ((await stat(file)).mtimeMs < r.source_started - 60000) continue;
      for (const match of await matchFile(file, plan))
        matches.push(match?.sessionId === session.name ? match : null);
    }
  }
  if (!matches.length)
    throw Error('Could not locate the captured request in the local DSH v4 session history.');
  if (matches.length !== 1 || !matches[0])
    throw Error('Could not uniquely locate the source reply in the local DSH history.');
  if (matches[0].error) throw Error(matches[0].error);
  return matches[0];
}

// Record the child ID before submitting its prompt. session.prompt deduplicates
// requestId; session.fork has no caller-supplied id and cannot be blindly retried.
export function dshResender(db, host, locate = locateDshPrompt, workspace) {
  const inflight = new Map();
  async function run(r, key, digest) {
    const client = host.client();
    // A retry from an older page can still carry a run-backed dispatch key.
    // Recover the original plan and child without repeating its fork.
    db.query(
      `INSERT OR IGNORE INTO dsh_dispatches(id,call_id,digest,origin,plan,child,state,error)
      SELECT a.id,e.call_id,?,a.base,a.marker,a.native_id,a.state,a.error
      FROM agent_chats a JOIN runs previous_run ON previous_run.id=a.run_id
      JOIN experiments e ON e.id=previous_run.experiment_id
      WHERE a.id=? AND a.target='dsh' AND a.workdir='' AND e.call_id=? AND e.body=?`,
    ).run(digest, key, r.call_id, r.body);
    const previous = db.query('SELECT * FROM dsh_dispatches WHERE id=?').get(key);
    if (previous) {
      if (
        previous.call_id !== r.call_id ||
        previous.origin !== client.origin ||
        previous.digest !== digest
      )
        throw Error('This resend belongs to a different request or Host.');
      if (previous.state === 'delivered')
        return { id: key, state: 'delivered', sessionId: previous.child };
      if (!previous.child)
        throw Error(
          previous.error ||
            'Fork delivery is unconfirmed. Check the DSH workspace before starting another resend.',
        );
    }
    const plan = previous
      ? JSON.parse(previous.plan)
      : r.agent === 'dsh'
        ? await locate(r)
        : {
            cwd: await workspace(r),
            content: [{ type: 'text', text: draftPrompt(r, JSON.parse(r.body)).prompt }],
          };
    let child = previous?.child;
    if (!child) {
      db.query(
        "INSERT INTO dsh_dispatches(id,call_id,digest,origin,plan,state) VALUES(?,?,?,?,?,'opening')",
      ).run(key, r.call_id, digest, client.origin, JSON.stringify(plan));
      try {
        const result = plan.cwd
          ? await client.create(plan.cwd, 'session-' + key)
          : await client.fork({ sessionId: plan.sessionId, atSeq: plan.atSeq });
        if (
          typeof result?.sessionId !== 'string' ||
          !result.sessionId ||
          result.sessionId === plan.sessionId
        )
          throw Error('Invalid DSH fork result.');
        child = result.sessionId;
        db.query('UPDATE dsh_dispatches SET child=? WHERE id=?').run(child, key);
      } catch (e) {
        if (e.refused) db.query('DELETE FROM dsh_dispatches WHERE id=?').run(key);
        else
          db.query("UPDATE dsh_dispatches SET state='failed',error=? WHERE id=?").run(
            e.message + ' Check the DSH workspace before creating another branch.',
            key,
          );
        throw e;
      }
    }
    const result = await client.prompt({
      sessionId: child,
      requestId: key,
      mode: 'queue',
      content: plan.content,
    });
    if (result?.accepted !== true) throw Error('DSH did not acknowledge the user prompt.');
    db.query("UPDATE dsh_dispatches SET state='delivered',error=NULL WHERE id=?").run(key);
    return { id: key, state: 'delivered', sessionId: child };
  }
  return (r, key) => {
    const digest = createHash('sha256').update(r.body).digest('hex');
    const prior = inflight.get(key);
    if (prior) {
      if (prior.callId !== r.call_id || prior.digest !== digest)
        throw Error('This resend belongs to another request.');
      return prior.promise;
    }
    const promise = run(r, key, digest).finally(() => inflight.delete(key));
    inflight.set(key, { callId: r.call_id, digest, promise });
    return promise;
  };
}
