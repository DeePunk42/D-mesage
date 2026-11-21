import { draftPrompt, texts, newChatWorkspace } from './agent-prompt.js';
// Claude owns background execution, tool approvals and the child transcript.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual, promisify } from 'node:util';

const exec = promisify(execFile);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function metadataId(request) {
  const user = request.metadata?.user_id;
  if (typeof user === 'object') return user?.session_id;
  if (typeof user !== 'string') return;
  try {
    return JSON.parse(user)?.session_id;
  } catch {
    return /(?:^|_)session_([a-f\d-]{36})$/i.exec(user)?.[1];
  }
}
export function claudePrompt(row, body) {
  const plan = draftPrompt(row, body),
    original = JSON.parse(row.request);
  if (!['claude', 'claude-code'].includes(row.agent)) return { ...plan, sessionId: null };
  const id = metadataId(original);
  if (uuid.test(id) && uuid.test(row.session) && row.session !== id)
    throw Error('The capture identifies two different Claude sessions.');
  return {
    ...plan,
    sessionId: uuid.test(id) ? id : uuid.test(row.session) ? row.session : null,
  };
}

async function anchor(info, candidates, started, selected) {
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const byId = new Map(candidates.map((m) => [m.uuid, m]));
  let result;
  for await (const path of new Bun.Glob('*/' + info.sessionId + '.jsonl').scan({
    cwd: projects,
    absolute: true,
  })) {
    const stream = createReadStream(path),
      lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('"user"')) continue;
        const entry = JSON.parse(line);
        const user = byId.get(entry.uuid);
        if (
          !user ||
          entry.isSidechain ||
          entry.sessionId !== info.sessionId ||
          entry.type !== 'user'
        )
          continue;
        if (!(Date.parse(entry.timestamp) <= started) || (selected && entry.uuid !== selected.uuid))
          continue;
        if (entry.parentUuid !== null && !uuid.test(entry.parentUuid)) continue;
        result = {
          cwd: entry.cwd || info.cwd,
          sessionId: info.sessionId,
          boundary: entry.parentUuid,
          original: texts(user.message).join('\n'),
        };
        if (selected) return result;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return result;
}

async function locate(row, plan) {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const sessions = plan.sessionId
    ? [await sdk.getSessionInfo(plan.sessionId)].filter(Boolean)
    : await sdk.listSessions();
  const matches = [];
  const end = Math.min(plan.index, plan.wire.length - 1);
  for (const info of sessions) {
    if (
      !plan.sessionId &&
      (info.createdAt > row.source_started + 2000 || info.lastModified < row.source_started - 60000)
    )
      continue;
    const messages = await sdk.getSessionMessages(info.sessionId, { dir: info.cwd });
    const users = messages.filter((m) => m.type === 'user' && texts(m.message).length);
    let selected;
    for (let i = end; i >= 0; i--) {
      if (plan.wire[i]?.role !== 'user') continue;
      const parts = texts(plan.wire[i]);
      const same = (m) =>
        parts.includes(texts(m.message).join('\n')) || isDeepStrictEqual(texts(m.message), parts);
      const found = users.filter((m) => texts(m.message).join('\n').trim() && same(m));
      if (!found.length) {
        // Without a native session ID, an older shared prefix cannot identify
        // which session handled this later prompt.
        if (!plan.sessionId && parts.some((text) => text?.trim())) break;
        continue;
      }
      const occurrences = plan.wire.flatMap((m, j) =>
        m.role === 'user' && isDeepStrictEqual(texts(m), parts) ? [j] : [],
      );
      if (found.length !== occurrences.length)
        throw Error('The input matches multiple possible Claude turns.');
      selected = found[occurrences.indexOf(i)];
      break;
    }
    // Claude also issues auxiliary Messages requests whose text is assembled
    // by the harness. For the current turn the immutable ID and native user
    // timestamps anchor such requests without matching generated reminder text.
    const current =
      !plan.changed || !plan.wire.slice(plan.index + 1).some((m) => m.role === 'user');
    if (selected || (plan.sessionId && current)) {
      const point = await anchor(
        info,
        users.filter((m) => texts(m.message).join('\n').trim()),
        row.source_started,
        selected,
      );
      if (point) matches.push(point);
    }
  }
  if (matches.length === 1) return matches[0];
  throw Error(
    matches.length
      ? 'Multiple local Claude sessions match this request.'
      : 'Could not locate the user message in the original Claude session.',
  );
}

async function launch(exe, cwd, child, prompt) {
  let output;
  try {
    ({ stdout: output } = await exec(
      exe,
      ['--bg', ...(child ? ['--resume', child] : []), '--', prompt],
      { cwd, timeout: 30000, maxBuffer: 1024 * 1024 },
    ));
  } catch (e) {
    // execFile's default message contains argv, including the whole draft.
    const detail = String(e.stderr || e.stdout || '')
      .trim()
      .slice(0, 450);
    throw Object.assign(Error(detail || 'Claude did not confirm background startup.'), {
      refused: /workspace not trusted/i.test(detail) || e.code === 'ENOENT',
    });
  }
  const job = /\bclaude attach ([\w-]+)/.exec(output)?.[1];
  if (!job)
    throw Error('Claude did not return a background job ID. Check claude agents before retrying.');
  return job;
}
async function backgroundJob(executable, cwd, job) {
  const { stdout } = await exec(executable, ['agents', '--all', '--json'], {
    cwd,
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout).find((entry) => entry.id === job);
}

// Status is queried only for a job recorded by a dispatch in this database.
export async function claudeJobStatus(db, id, detect, lookup = backgroundJob) {
  const row = db.query('SELECT cwd,child,job,stage FROM claude_dispatches WHERE id=?').get(id);
  if (!row?.job) return null;
  const executable = detect('claude');
  if (!executable) throw Error('Claude Code is unavailable. Check its executable in Settings.');
  const job = await lookup(executable, row.cwd, row.job);
  if (row.child && row.stage === 'delivered' && job?.sessionId && row.child !== job.sessionId)
    throw Error('The Claude background job now belongs to another session.');
  if (uuid.test(job?.sessionId) && row.stage === 'started')
    db.query(
      "UPDATE claude_dispatches SET child=?,stage='delivered' WHERE id=? AND stage='started'",
    ).run(job.sessionId, id);
  return {
    job: row.job,
    sessionId: job?.sessionId || row.child,
    activity:
      job?.waitingFor === 'permission prompt'
        ? 'approval'
        : job?.state === 'blocked'
          ? 'blocked'
          : job?.status || job?.state || 'unknown',
    waitingFor: job?.waitingFor || null,
  };
}

export function claudeDispatcher(
  db,
  {
    detect,
    dataDir,
    locateSource = locate,
    fork = async (id, options) =>
      (await import('@anthropic-ai/claude-agent-sdk')).forkSession(id, options),
    startJob = launch,
    jobSession = async (exe, cwd, job) => (await backgroundJob(exe, cwd, job))?.sessionId,
  },
) {
  const active = new Map();
  async function send(row, plan, key, digest) {
    const exe = detect('claude');
    if (!exe) throw Error('Claude Code is unavailable. Check its executable in Settings.');
    let r = db.query('SELECT * FROM claude_dispatches WHERE id=?').get(key);
    if (r && (r.call_id !== row.call_id || r.digest !== digest))
      throw Error('This send ID belongs to another draft.');
    if (!r) {
      const source = ['claude', 'claude-code'].includes(row.agent)
        ? await locateSource(row, plan)
        : { cwd: await newChatWorkspace(row, dataDir), original: plan.prompt };
      const cwd = source.cwd;
      if (!cwd) throw Error('The original Claude workspace could not be located.');
      db.query(
        "INSERT INTO claude_dispatches(id,call_id,digest,cwd,prompt,stage) VALUES(?,?,?,?,?,'forking')",
      ).run(key, row.call_id, digest, cwd, plan.changed ? plan.prompt : source.original);
      const child = source?.boundary
        ? (await fork(source.sessionId, { dir: cwd, upToMessageId: source.boundary })).sessionId
        : null;
      if (source?.boundary && (!uuid.test(child) || child === source.sessionId))
        throw Error('Claude did not confirm the new branch.');
      db.query("UPDATE claude_dispatches SET child=?,stage='ready' WHERE id=?").run(child, key);
      r = db.query('SELECT * FROM claude_dispatches WHERE id=?').get(key);
    }
    if (r.stage === 'ready') {
      if (
        !db
          .query("UPDATE claude_dispatches SET stage='starting' WHERE id=? AND stage='ready'")
          .run(key).changes
      )
        throw Error('Claude dispatch already in progress.');
      r.job = await startJob(exe, r.cwd, r.child, r.prompt);
      db.query("UPDATE claude_dispatches SET job=?,stage='started' WHERE id=?").run(r.job, key);
    }
    if (!r.job)
      throw Error(
        'Claude did not confirm the previous dispatch. Check claude agents before sending again.',
      );
    if (r.stage !== 'delivered') {
      // Startup already returned a job handle. A temporarily unavailable
      // roster must not turn accepted execution into a reason to launch again.
      let actual;
      try {
        actual = await jobSession(exe, r.cwd, r.job);
      } catch {}
      if (uuid.test(actual)) {
        r.child = actual;
        db.query("UPDATE claude_dispatches SET child=?,stage='delivered' WHERE id=?").run(
          actual,
          key,
        );
      }
    }
    return { id: key, state: 'accepted', sessionId: r.child, job: r.job };
  }
  return (row, body, key) => {
    const plan = claudePrompt(row, body),
      digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const prior = active.get(key);
    if (prior) {
      if (prior.callId !== row.call_id || prior.digest !== digest)
        throw Error('This send ID belongs to another draft.');
      return prior.promise;
    }
    const promise = send(row, plan, key, digest).finally(() => active.delete(key));
    active.set(key, { callId: row.call_id, digest, promise });
    return promise;
  };
}
