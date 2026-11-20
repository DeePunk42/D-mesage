import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  existsSync, accessSync, constants,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
  realpathSync,
  readFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './store.js';
import {
  branchInput,
  checkPendingTool,
  continuationPlan,
  savedAnswer,
  targetReason,
  forTarget,
} from './continue-protocol.js';
import { codexDispatcher, codexRequestDigest, codexSource, openCodexThread } from './codex-dispatch.js';
import { editedDshPrompt, dshResender } from './dsh-prompt.js';
import { dshHost } from './dsh-host.js';
import { endpointFor } from './ui/protocols.js';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const worker = fileURLToPath(new URL('./continue-launch.js', import.meta.url));
const continuationTargets = ['claude', 'codex', 'dsh'];
function detectedExecutable(target) {
  const bundled = {
    codex:
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    dsh: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  };
  if (target === 'dsh') return existsSync(bundled.dsh) ? bundled.dsh : null;
  if (!['claude', 'codex'].includes(target)) return null;
  return (
    Bun.which(target, {
      PATH: [
        process.env.PATH,
        join(homedir(), '.local/bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ].join(':'),
    }) || (bundled[target] && existsSync(bundled[target]) ? bundled[target] : null)
  );
}
function availableExecutable(path) {
  if (!isAbsolute(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch { return false; }
}
export function replayAgentSettings(db, target) {
  const path = db.query('SELECT value FROM settings WHERE key=?').get('replay_path:' + target)?.value || '';
  const detected = detectedExecutable(target) || '';
  return { id: target, path, detected, available: path ? availableExecutable(path) : !!detected };
}
export function setReplayAgentPath(db, target, path) {
  if (!['codex','claude'].includes(target) || typeof path !== 'string' || (path && !availableExecutable(path)))
    throw Error('Enter an absolute path to an executable, or clear it to use automatic detection.');
  if (path) db.query('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('replay_path:' + target, path);
  else db.query('DELETE FROM settings WHERE key=?').run('replay_path:' + target);
  return replayAgentSettings(db, target);
}
export function agentExecutable(target, db) {
  if (!db || !['codex','claude'].includes(target)) return detectedExecutable(target);
  const agent = replayAgentSettings(db, target);
  return agent.available ? agent.path || agent.detected : null;
}
export function running(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
async function openTerminal(id) {
  const dir = mkdtempSync(join(tmpdir(), 'd-message-launch-'));
  const script = join(dir, 'Continue.command');
  try {
    writeFileSync(
      script,
      '#!/bin/sh\nrm -f -- "$0"\nrmdir -- ' +
        quote(dir) +
        '\nexec env ' +
        quote('D_MESSAGE_DATA_DIR=' + dataDir) +
        ' ' +
        quote(process.execPath) +
        ' ' +
        quote(worker) +
        ' ' +
        quote(id) +
        '\n',
      { mode: 0o700 },
    );
    const p = Bun.spawn(['/usr/bin/open', '-b', 'com.apple.Terminal', script], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    if (await p.exited) throw Error('Terminal could not open the continuation.');
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
function readableFile(path) {
  try {
    return statSync(path).isFile() && realpathSync(path) === path;
  } catch {
    return false;
  }
}
function nativeSession(chat, headers) {
  if (chat.target === 'claude') return chat.id;
  if (chat.target === 'dsh') {
    let id = headers.get('x-deepseek-harness-session-id');
    if (!id) {
      try {
        id = readFileSync(
          join(dataDir, 'agent-workspaces', chat.id, 'profile', 'continued-session'),
          'utf8',
        );
      } catch {
        return null;
      }
    }
    return id.startsWith('session-') && uuid.test(id.slice(8)) ? id : null;
  }
  const id =
    headers.get('thread-id') ||
    headers.get('session-id') ||
    headers.get('session_id') ||
    headers.get('x-openai-thread-id');
  return uuid.test(id || '') ? id : null;
}
function readRun(db, run) {
  const r = db
    .query(
      `SELECT r.status,r.kind,r.reply,r.rowid AS seq,e.body,c.id AS call_id,c.agent,c.protocol,c.endpoint,c.request,c.session,c.reply AS source_reply,c.started AS source_started
    FROM runs r JOIN experiments e ON e.id=r.experiment_id JOIN calls c ON c.id=e.call_id WHERE r.id=?`,
    )
    .get(run);
  if (!r || r.kind !== 'send' || r.status !== 'complete' || !r.reply)
    throw Error('Select a completed replay run.');
  return r;
}
function planFor(r) {
  return continuationPlan(
    r.protocol,
    JSON.parse(r.body),
    JSON.parse(r.reply),
    JSON.parse(r.request),
  );
}
export function createContinuations(
  db,
  {
    port,
    upstream,
    uiKey,
    refreshAgents,
    host = dshHost(),
    locateDsh,
    codexServer,
    openCodex = openCodexThread,
    launch = openTerminal,
    detect = id => agentExecutable(id, db),
    platform = process.platform,
  },
) {
  const dispatchCodex = codexDispatcher(db, { detect, server: codexServer, open: openCodex });
  function requestRow(ref) {
    const fields =
      'c.id AS call_id,c.agent,c.protocol,c.session,c.started AS source_started,c.request';
    const row = ref.startsWith('capture/')
      ? db
          .query('SELECT ' + fields + ',c.request AS body FROM calls c WHERE c.id=?')
          .get(ref.slice(8))
      : db
          .query(
            `SELECT ${fields},CASE WHEN r.kind='baseline' THEN c.request ELSE e.body END AS body FROM runs r JOIN experiments e ON e.id=r.experiment_id JOIN calls c ON c.id=e.call_id WHERE r.id=?`,
          )
          .get(ref);
    if (!row) throw Error('The source request no longer exists.');
    return row;
  }
  function codexTarget(row) {
    let reason = '';
    try {
      codexSource(row);
      if (platform !== 'darwin') throw Error('Opening a native agent currently requires macOS.');
      if (!detect('codex')) throw Error('Codex is unavailable. Check its executable in Settings.');
    } catch (e) {
      reason = e.message;
    }
    const previous =
      !reason &&
      db
        .query(
          "SELECT id FROM codex_dispatches WHERE call_id=? AND digest=? AND stage IN ('queued','opened') ORDER BY rowid DESC LIMIT 1",
        )
        .get(row.call_id, codexRequestDigest(JSON.parse(row.body)));
    return { id: 'codex', reason, reopen: previous?.id || null };
  }
  function dshRow(row, request) {
    row.source_reply = db.query('SELECT reply FROM calls WHERE id=?').get(row.call_id)?.reply;
    if (request !== undefined) row.body = JSON.stringify(request);
    return row;
  }
  function dshTarget(row) {
    let reason = '';
    try { editedDshPrompt(row); host.client(); } catch (error) { reason = error.message; }
    return { id: 'dsh', reason, reopen: null };
  }
  const resend = dshResender(db, host, locateDsh);
  const sign = (id) =>
    createHmac('sha256', uiKey)
      .update('agent-chat-v1/' + id)
      .digest('hex');
  const route = (id) => 'http://127.0.0.1:' + port + '/branch/' + id;
  const marker = (id, seq) => 'Continue from D-message run R' + seq + ' (' + id + ').';
  function capability(id, plan, err) {
    return (
      err ||
      targetReason(id, plan) ||
      (platform !== 'darwin' ? 'Opening a native agent currently requires macOS.' : '') ||
      (!detect(id) ? 'Agent is not installed on this computer.' : '')
    );
  }
  function targets(original) {
    const connected = db
      .query("SELECT value FROM capture_options WHERE kind='connected_agent' ORDER BY value")
      .all();
    const candidates = new Set([original, ...connected.map((row) => row.value)]);
    return continuationTargets.filter((id) => candidates.has(id));
  }
  async function options(run) {
    if (
      run.startsWith('capture/') ||
      !db
        .query(
          "SELECT 1 FROM runs WHERE id=? AND kind='send' AND status='complete' AND reply IS NOT NULL",
        )
        .get(run)
    ) {
      const row = requestRow(run);
      let target;
      if (row.agent === 'dsh') target = dshTarget(dshRow(row));
      else if (row.agent === 'codex') target = codexTarget(row);
      else throw Error('Select a completed replay run.');
      return { original: row.agent, targets: [target], read: null, command: null };
    }
    const r = readRun(db, run);
    await refreshAgents();
    let plan, error;
    try {
      plan = planFor(r);
      if (plan.call?.path && !readableFile(plan.call.path))
        error = 'The requested file is missing or its path is not canonical.';
    } catch (e) {
      error = e.message;
    }
    const last = db
      .query(
        "SELECT id,target,owner FROM agent_chats WHERE run_id=? AND state='delivered' AND native_id IS NOT NULL ORDER BY rowid DESC",
      )
      .all(run);
    return {
      original: r.agent,
      read: plan?.call?.path || null,
      command: plan?.call?.command || null,
      targets: targets(r.agent).map((id) => {
        if (id === 'codex') return codexTarget(r);
        if (id === 'dsh') return dshTarget({ ...r, body: r.request });
        const chat = last.find((c) => c.target === id);
        return {
          id,
          reason: capability(id, plan, error),
          reopen: chat && !running(chat.owner) ? chat.id : null,
        };
      }),
    };
  }
  async function reopen(run, id, target) {
    const chat = db
      .query(
        "SELECT * FROM agent_chats WHERE id=? AND run_id=? AND target=? AND state='delivered' AND native_id IS NOT NULL",
      )
      .get(id, run, target);
    if (!chat || !detect(target)) throw Error('This agent chat cannot be reopened.');
    if (running(chat.owner)) throw Error('This chat already has a running agent.');
    db.query('UPDATE agent_chats SET base=?,access_key=? WHERE id=?').run(route(id), sign(id), id);
    await launch(id);
    return { id, state: 'reopened' };
  }
  async function start(run, { target, key, approvedFile, reopen: id, request }) {
    if (!continuationTargets.includes(target)) throw Error('Unsupported continuation target.');
    if (id && target === 'codex') {
      const source = requestRow(run);
      const branch = db
        .query(
          "SELECT child FROM codex_dispatches WHERE id=? AND call_id=? AND stage IN ('queued','opened')",
        )
        .get(id, source.call_id);
      if (branch) {
        await openCodex(branch.child);
        db.query("UPDATE codex_dispatches SET stage='opened' WHERE id=?").run(id);
      } else {
        const legacy = db
          .query(
            "SELECT native_id FROM agent_chats WHERE id=? AND run_id=? AND target='codex' AND state='delivered'",
          )
          .get(id, run);
        if (!legacy?.native_id) throw Error('This Codex chat cannot be reopened.');
        await openCodex(legacy.native_id);
      }
      return { id, state: 'reopened' };
    }
    if (id && target === 'dsh') throw Error('DSH chats are reopened in the existing DSH workspace.');
    if (id) return reopen(run, id, target);
    if (typeof key !== 'string' || !uuid.test(key)) throw Error('Invalid launch identifier.');
    if (target === 'codex') {
      const row = requestRow(run),
        reason = codexTarget(row).reason;
      if (reason) throw Error(reason);
      return dispatchCodex(row, request === undefined ? JSON.parse(row.body) : request, key);
    }
    if (target === 'dsh') return resend(dshRow(requestRow(run), request), key);
    const prior = db.query('SELECT id,run_id,target,state FROM agent_chats WHERE id=?').get(key);
    if (prior) {
      if (prior.run_id !== run || prior.target !== target)
        throw Error('Launch identifier already used.');
      return { id: key, state: prior.state };
    }
    const r = readRun(db, run),
      plan = planFor(r);
    const reason = capability(target, plan);
    if (reason) throw Error(reason);
    if (!targets(r.agent).includes(target)) throw Error('Target is not in the agent catalog.');
    if (plan.call?.path && (approvedFile !== plan.call.path || !readableFile(plan.call.path)))
      throw Error('Review the exact local file before continuing.');
    const working = join(dataDir, 'agent-workspaces', key, 'work');
    mkdirSync(working, { recursive: true, mode: 0o700 });
    db.query(
      "INSERT INTO agent_chats(id,run_id,target,state,base,workdir,marker,access_key,approved_command) VALUES(?,?,?,'opening',?,?,?,?,?)",
    ).run(
      key,
      run,
      target,
      route(key),
      working,
      marker(key, r.seq),
      sign(key),
      plan.call?.command ?? null,
    );
    try {
      await launch(key);
    } catch (e) {
      db.query("UPDATE agent_chats SET state='failed',error=? WHERE id=?").run(e.message, key);
      throw e;
    }
    return { id: key, state: 'opening' };
  }
  async function serve(req, path, awaitingModel) {
    const m = /^\/branch\/([\da-f-]{36})(\/[^?]*)$/.exec(path);
    const credential =
      req.headers.get('x-api-key') || req.headers.get('authorization')?.replace(/^Bearer /i, '');
    if (
      !m ||
      !/^[a-f0-9]{64}$/.test(credential || '') ||
      req.headers.has('origin') ||
      !timingSafeEqual(Buffer.from(credential), Buffer.from(sign(m[1])))
    )
      return new Response(null, { status: 403 });
    const [, id, endpoint] = m;
    const chat = db.query('SELECT * FROM agent_chats WHERE id=?').get(id);
    if (!chat || chat.state === 'failed') return new Response(null, { status: 410 });
    let firstRequest = false;
    try {
      const row = readRun(db, chat.run_id),
        plan = forTarget(chat.target, planFor(row));
      if (req.method !== 'POST' || endpoint !== endpointFor(plan.protocol))
        return new Response(null, { status: 404 });
      const incoming = await req.json();
      const { continued, next, receipt } = branchInput(plan, incoming, chat.marker);
      if (!continued) {
        firstRequest = true;
        checkPendingTool(incoming, plan.call);
        if ((plan.call?.command ?? null) !== chat.approved_command)
          throw Error('The pending command changed after this chat was opened.');
        if (plan.call?.path && !readableFile(plan.call.path))
          throw Error('The approved file has changed location.');
        const result = savedAnswer(plan, !!incoming.stream);
        const native = nativeSession(chat, req.headers);
        const used = db
          .query(
            "UPDATE agent_chats SET state='delivered',native_id=?,tool_receipt=? WHERE id=? AND state='opening'",
          )
          .run(native, plan.call ? 'pending' : null, id);
        if (!used.changes) throw Error('This saved answer has already been delivered.');
        return result;
      }
      if (chat.state !== 'delivered') throw Error('This chat has not received its saved answer.');
      if (chat.tool_receipt === 'pending' && receipt)
        db.query("UPDATE agent_chats SET tool_receipt=? WHERE id=? AND tool_receipt='pending'").run(
          receipt,
          id,
        );
      // All subsequent inference uses the configured gateway. Agent credentials and
      // continuation capabilities never leave this listener.
      const url = new URL(endpointFor(plan.protocol, row.endpoint), upstream);
      const headers = {
        'content-type': 'application/json',
        authorization: 'Bearer magpie-d-message',
        'user-agent': 'd-message/1',
        'x-magpie-session': 'continue-' + id,
      };
      if (plan.protocol === 'anthropic') {
        headers['x-api-key'] = 'magpie-d-message';
        headers['anthropic-version'] = '2023-06-01';
      }
      const body = JSON.stringify(next);
      if (body.includes(credential))
        throw Error('A private continuation credential appeared in the request.');
      awaitingModel?.();
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers,
        redirect: 'error',
        signal: req.signal,
      });
      return new Response(res.body, {
        status: res.status,
        headers: {
          'content-type': res.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store',
        },
      });
    } catch (e) {
      const message = e.message || 'Agent continuation failed.';
      if (firstRequest)
        db.query(
          "UPDATE agent_chats SET state='failed',error=? WHERE id=? AND state='opening'",
        ).run(message, id);
      return Response.json(
        { type: 'error', error: { type: 'invalid_request_error', message } },
        { status: 409 },
      );
    }
  }
  return { options, start, serve };
}
