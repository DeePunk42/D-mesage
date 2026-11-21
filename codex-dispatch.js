import { draftPrompt, newChatWorkspace } from './agent-prompt.js';
// Short-lived stdio sessions never resume the parent. The desktop is the only
// client that resumes the queued child and owns its inference and approvals.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function inputItems(body) {
  if (typeof body?.input === 'string') return [{ role: 'user', content: body.input }];
  if (!Array.isArray(body?.input)) throw Error('The Codex request has no local message history.');
  return body.input;
}
function userInput(item) {
  if (item?.role !== 'user') return null;
  const blocks =
    typeof item.content === 'string' ? [{ type: 'input_text', text: item.content }] : item.content;
  if (!Array.isArray(blocks) || !blocks.length) return null;
  const output = [];
  for (const b of blocks) {
    if (b?.type === 'input_text' && typeof b.text === 'string')
      output.push({ type: 'text', text: b.text, text_elements: [] });
    else if (b?.type === 'input_image' && typeof b.image_url === 'string')
      output.push({ type: 'image', url: b.image_url, ...(b.detail ? { detail: b.detail } : {}) });
    else return null;
  }
  return output;
}
function signature(parts) {
  if (!parts?.length) return null;
  return JSON.stringify(
    parts.map((b) =>
      b.type === 'text' ? ['text', b.text] : [b.type, b.url ?? b.path ?? b.name ?? b.id],
    ),
  );
}
export function codexSource(row) {
  if (row.agent !== 'codex' || row.protocol !== 'responses')
    throw Error('Select a Codex Responses protocol capture to fork its thread.');
  const request = JSON.parse(row.request);
  const meta = request.client_metadata || {};
  if (uuid.test(row.session) && uuid.test(meta.thread_id) && row.session !== meta.thread_id)
    throw Error('The capture identifies two different Codex threads.');
  const threadId = uuid.test(meta.thread_id) ? meta.thread_id : row.session;
  if (!uuid.test(threadId)) throw Error('The capture has no native Codex thread ID.');
  return { request, threadId, turnId: uuid.test(meta.turn_id) ? meta.turn_id : null };
}
export function codexChange(row, body) {
  const source = codexSource(row),
    original = inputItems(source.request),
    edited = inputItems(body);
  let index = -1;
  if (edited.length < original.length || edited.length > original.length + 1)
    throw Error('Edit one user message or append one user message to resend in Codex.');
  for (let i = 0; i < edited.length; i++) {
    if (isDeepStrictEqual(original[i], edited[i])) continue;
    if (index >= 0 || !userInput(edited[i]) || (original[i] && original[i].role !== 'user'))
      throw Error('Codex can resend one edited user message per branch.');
    index = i;
  }
  const input = index >= 0 ? userInput(edited[index]) : null;
  if (input && !input.some((b) => b.type !== 'text' || b.text.trim()))
    throw Error('The edited Codex user message is empty.');
  return { ...source, original, index, input };
}
async function withServer(executable, use) {
  const proc = spawn(executable, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  let serial = 0,
    pending,
    closed = false;
  const ended = new Promise((resolve) => {
    proc.once('error', () => resolve());
    proc.once('close', resolve);
  }).then(() => {
    closed = true;
    pending?.reject(Error('Codex App Server stopped. Check the Codex executable in Settings.'));
  });
  proc.stdin.on('error', () => pending?.reject(Error('Codex App Server closed its input.')));
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method || !pending || message.id !== pending.id) return;
    if (message.error)
      pending.reject(
        Object.assign(Error(message.error.message || 'Codex RPC failed.'), { rpcError: true }),
      );
    else pending.resolve(message.result);
  });
  async function call(method, params) {
    if (closed) throw Error('Codex App Server is unavailable.');
    const id = ++serial;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending = { id, resolve, reject };
        timer = setTimeout(() => reject(Error('Codex timed out during ' + method + '.')), 30000);
        proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    } finally {
      clearTimeout(timer);
      pending = null;
    }
  }
  try {
    await call('initialize', {
      clientInfo: { name: 'd_message', version: '1' },
      capabilities: { experimentalApi: true },
    });
    proc.stdin.write('{"method":"initialized"}\n');
    return await use(call);
  } finally {
    proc.stdin.end();
    const kill = setTimeout(() => proc.kill('SIGKILL'), 3000);
    await ended;
    clearTimeout(kill);
    lines.close();
  }
}

async function history(call, threadId) {
  const turns = [];
  let cursor;
  do {
    const page = await call('thread/turns/list', {
      threadId,
      sortDirection: 'asc',
      itemsView: 'summary',
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    for (const turn of page.data)
      turns.push({
        id: turn.id,
        started: turn.startedAt,
        ended: turn.completedAt,
        users: turn.items
          .filter((i) => i.type === 'userMessage')
          .map((i) => ({ input: i.content, key: signature(i.content), clientId: i.clientId })),
      });
    cursor = page.nextCursor;
  } while (cursor);
  return turns;
}

export function codexForkPoint(plan, turns, started) {
  const second = Math.floor(started / 1000);
  const candidates = plan.turnId
    ? turns.filter((t) => t.id === plan.turnId)
    : turns.filter(
        (t) => t.started != null && t.started <= second && (t.ended == null || t.ended >= second),
      );
  const capture = candidates.length === 1 ? candidates[0] : null;
  if (plan.turnId && !capture) throw Error('The captured turn was not found in this Codex thread.');
  const prefix = capture
    ? turns.slice(0, turns.indexOf(capture) + 1)
    : turns.filter((t) => t.started != null && t.started <= second);
  const wire = plan.original.map((i) => signature(userInput(i)));
  const users = prefix.flatMap((t) => t.users.map((u) => ({ ...u, turn: t.id })));
  if (plan.index < 0) {
    const user = capture?.users.at(-1);
    if (!user?.input?.length)
      throw Error(
        'Could not locate the original Codex user input. Edit a user message in the request.',
      );
    return { beforeTurnId: capture.id, input: user.input };
  }
  if (plan.index === wire.length && capture) return { beforeTurnId: capture.id, input: plan.input };
  // Generated user-role blocks can also be resent. Anchor them to the
  // neighboring native prompt in the captured request, keeping earlier edits
  // on their own turn even when the capture spans many turns.
  for (let i = plan.index; i >= 0; i--) {
    const key = wire[i];
    if (!key) continue;
    const matches = users.filter((u) => u.key === key);
    if (!matches.length) continue;
    const occurrences = wire.flatMap((value, j) => (value === key ? [j] : []));
    const match = occurrences.length === matches.length ? matches[occurrences.indexOf(i)] : null;
    if (!match) throw Error('The edited input matches multiple Codex turns.');
    return { beforeTurnId: match.turn, input: plan.input };
  }
  // A request may start with generated context before its first real prompt.
  for (let i = plan.index + 1; i < wire.length; i++) {
    const matches = users.filter((u) => u.key && u.key === wire[i]);
    if (matches.length === 1 && wire.filter((k) => k === wire[i]).length === 1)
      return { beforeTurnId: matches[0].turn, input: plan.input };
    if (matches.length) break;
  }
  if (capture && !wire.some((k) => k && users.some((u) => u.key === k)))
    return { beforeTurnId: capture.id, input: plan.input };
  throw Error('Could not uniquely locate the edited message in Codex history.');
}

export async function openCodexThread(id) {
  if (!uuid.test(id)) throw Error('Invalid Codex branch ID.');
  const p = spawn('/usr/bin/open', ['codex://threads/' + id], { stdio: 'ignore' });
  const [code] = await once(p, 'close');
  if (code !== 0) throw Error('The message is queued. Retry to open its Codex branch.');
}

export function codexRequestDigest(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export function codexDispatcher(
  db,
  { detect, dataDir, server = withServer, open = openCodexThread },
) {
  const inflight = new Map();
  async function dispatch(row, body, id, digest) {
    const exe = detect('codex');
    if (!exe) throw Error('Codex is unavailable. Check its executable in Settings.');
    const native = row.agent === 'codex';
    const plan = native ? codexChange(row, body) : draftPrompt(row, body);
    let record = db.query('SELECT * FROM codex_dispatches WHERE id=?').get(id);
    if (record && (record.call_id !== row.call_id || record.digest !== digest))
      throw Error('This send ID belongs to a different request.');
    if (!record) {
      await server(exe, async (call) => {
        const point = native
          ? codexForkPoint(plan, await history(call, plan.threadId), row.source_started)
          : { input: [{ type: 'text', text: plan.prompt, text_elements: [] }] };
        db.query(
          "INSERT INTO codex_dispatches(id,call_id,digest,stage,input) VALUES(?,?,?,'forking',?)",
        ).run(id, row.call_id, digest, JSON.stringify(point.input));
        let fork;
        try {
          fork = native
            ? await call('thread/fork', {
                threadId: plan.threadId,
                beforeTurnId: point.beforeTurnId,
                ephemeral: false,
                excludeTurns: true,
                deferGoalContinuation: true,
              })
            : await call('thread/start', {
                cwd: await newChatWorkspace(row, dataDir),
                ephemeral: false,
              });
          // Naming materializes a new, empty session before the separate queue client opens it.
          if (!native)
            await call('thread/name/set', {
              threadId: fork.thread.id,
              name: 'D-message · ' + plan.prompt.trim().split('\n')[0].slice(0, 60),
            });
        } catch (error) {
          if (error.rpcError) db.query('DELETE FROM codex_dispatches WHERE id=?').run(id);
          throw error;
        }
        if (!uuid.test(fork?.thread?.id) || fork.thread.id === plan.threadId)
          throw Error('Codex did not acknowledge the new branch.');
        db.query("UPDATE codex_dispatches SET child=?,stage='forked' WHERE id=?").run(
          fork.thread.id,
          id,
        );
      });
      record = db.query('SELECT * FROM codex_dispatches WHERE id=?').get(id);
    }
    if (!record?.child)
      throw Error('Codex did not confirm the branch ID. Check the app before sending again.');
    const threadId = record.child;
    if (record.stage === 'adding' || record.stage === 'forked') {
      await server(exe, async (call) => {
        if (record.stage === 'adding') {
          const page = await call('thread/queue/list', { threadId });
          const known =
            page.data.some((q) => q.clientUserMessageId === id) ||
            (await history(call, threadId)).some((t) => t.users.some((u) => u.clientId === id));
          if (!known)
            throw Error(
              'Codex did not confirm delivery. Check the branch before sending again: ' + threadId,
            );
        } else {
          const claimed = db
            .query("UPDATE codex_dispatches SET stage='adding' WHERE id=? AND stage='forked'")
            .run(id);
          if (!claimed.changes) throw Error('Another client is already sending this request.');
          const acknowledgment = await call('thread/queue/add', {
            threadId,
            clientUserMessageId: id,
            input: JSON.parse(record.input),
          });
          if (acknowledgment?.queuedSubmission?.clientUserMessageId !== id)
            throw Error('Codex did not acknowledge the queued message.');
        }
        db.query("UPDATE codex_dispatches SET stage='queued' WHERE id=? AND stage='adding'").run(
          id,
        );
      });
    }
    if (record.stage !== 'opened') {
      await open(threadId);
      db.query("UPDATE codex_dispatches SET stage='opened' WHERE id=?").run(id);
    }
    return { id, state: 'delivered', sessionId: threadId };
  }
  return (row, body, id) => {
    const digest = codexRequestDigest(body);
    const prior = inflight.get(id);
    if (prior) {
      if (prior.callId !== row.call_id || prior.digest !== digest)
        throw Error('This send ID belongs to a different request.');
      return prior.promise;
    }
    const promise = dispatch(row, body, id, digest).finally(() => inflight.delete(id));
    inflight.set(id, { callId: row.call_id, digest, promise });
    return promise;
  };
}
