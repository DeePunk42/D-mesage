import { validRequest } from './ui/protocols.js';
import { isDeepStrictEqual } from 'node:util';
import {
  storage,
  checkLegacyOutcome,
  isReplayAgent,
  reconcile,
  recording,
  setRecording,
  captureCursor,
  captureChoices,
  editCaptureChoices,
  captureScope,
  saveScope,
} from './store.js';
import { z } from 'zod';
import { launch } from './replay.js';

const ids = z.array(z.string().trim().min(1)).transform((values) => [...new Set(values)].sort());
const agentIds = ids.refine((a) => !a.some(isReplayAgent), 'Choose a client other than D-message.');
export const scopeSchema = z.strictObject({
  agents: z.union([
    z.literal('all'),
    agentIds.refine((a) => a.length > 0),
  ]),
});
const scopeEditSchema = z.strictObject({
  agents: z.union([z.literal('all'), agentIds]),
  add: agentIds.default([]),
  remove: ids.default([]),
});
export function configureCaptureScope(input) {
  const { agents, add, remove } = scopeEditSchema.parse(input);
  if (remove.some((id) => add.includes(id) || (agents !== 'all' && agents.includes(id))))
    throw Error('A removed agent cannot also be added or selected.');
  return recordState('configure', { agents }, { add, remove });
}
export function recordState(action, scope, edits) {
  const db = storage();
  return db
    .transaction(() => {
      if (scope !== undefined) {
        if (action !== 'start' && action !== 'configure')
          throw Error('Only start and configure can change the capture scope.');
        if (edits) editCaptureChoices(db, edits.add, edits.remove);
        saveScope(db, edits ? scope : scopeSchema.parse(scope));
      } else if (action === 'configure') throw Error('Provide a capture scope.');
      if (action === 'start' || action === 'stop') setRecording(action === 'start', db);
      return {
        recording: recording(db),
        scope: captureScope(db),
        choices: captureChoices(db),
        cursor: captureCursor(db),
      };
    })
    .immediate();
}

export function listTraces({ after = 0, session, limit = 25 }) {
  const db = storage();
  reconcile();
  const filter = session === undefined ? '' : ' AND session=?';
  const params = session === undefined ? [after, limit + 1] : [after, session, limit + 1];
  const rows = db
    .query(
      `SELECT rowid AS cursor,id,session,agent,model,protocol,endpoint,status,started,ended,last_role,last_preview
    FROM calls WHERE rowid>? ${filter} ORDER BY rowid LIMIT ?`,
    )
    .all(...params);
  const traces = rows.slice(0, limit).map(({ id, ...row }) => ({ ref: 'trace:' + id, ...row }));
  return { traces, cursor: traces.at(-1)?.cursor ?? after, has_more: rows.length > limit };
}

export function snapshot(ref) {
  const [kind, id] = ref.split(':');
  if (kind === 'trace') checkLegacyOutcome(storage(), id);
  const queries = {
    trace:
      "SELECT id AS call_id,session,agent,model,protocol,endpoint,started,ended,status,request,reply,json_extract(failure,'$.message') AS error,failure FROM calls WHERE id=?",
    draft: `SELECT c.id AS call_id,c.session,c.agent,json_extract(e.body,'$.model') AS model,c.protocol,c.endpoint,e.created AS started,NULL AS ended,'draft' AS status,e.body AS request,NULL AS reply,NULL AS error
      FROM experiments e JOIN calls c ON c.id=e.call_id WHERE e.id=?`,
    run: `SELECT c.id AS call_id,c.session,c.agent,coalesce(r.model,c.model) AS model,c.protocol,c.endpoint,r.started,r.ended,r.status,
      CASE WHEN r.kind='baseline' THEN c.request ELSE e.body END AS request,r.reply,r.error
      FROM runs r JOIN experiments e ON e.id=r.experiment_id JOIN calls c ON c.id=e.call_id WHERE r.id=?`,
  };
  const row = storage().query(queries[kind]).get(id);
  if (!row) throw Error('Snapshot not found: ' + ref);
  if (row.failure) row.failure = JSON.parse(row.failure);
  return row;
}

function parts(path) {
  if (path === '') return [];
  if (!path.startsWith('/') || /~(?![01])/.test(path))
    throw Error('Expected an RFC 6901 JSON Pointer.');
  return path
    .slice(1)
    .split('/')
    .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'));
}
function indexOf(arr, key, append = false) {
  if (key === '-' && append) return arr.length;
  const n = Number(key);
  if (!/^(0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(n) || n > arr.length - (append ? 0 : 1))
    throw Error('Invalid array index.');
  return n;
}
function lookup(obj, tokens) {
  for (const key of tokens) {
    if (obj === null || typeof obj !== 'object' || !Object.hasOwn(obj, key))
      throw Error('JSON path not found.');
    if (Array.isArray(obj)) indexOf(obj, key);
    obj = obj[key];
  }
  return obj;
}
export function getTrace({ ref, view = 'summary', path = '' }) {
  reconcile();
  const { request, reply, call_id, ...info } = snapshot(ref);
  const meta = { ref, trace_ref: 'trace:' + call_id, ...info };
  const value =
    view === 'summary' ? meta : JSON.parse((view === 'request' ? request : reply) ?? 'null');
  return { ...meta, view, value: lookup(value, parts(path)) };
}
export function editTrace({ ref, ops }) {
  const source = snapshot(ref);
  let body = JSON.parse(source.request);
  for (const [i, op] of ops.entries()) {
    try {
      const keys = parts(op.path);
      if (op.op !== 'remove' && !Object.hasOwn(op, 'value'))
        throw Error('This operation requires a value.');
      if (op.op === 'test') {
        if (!isDeepStrictEqual(lookup(body, keys), op.value))
          throw Error('Test value did not match.');
        continue;
      }
      if (!keys.length) {
        if (op.op === 'remove') throw Error('Cannot remove the entire request.');
        body = structuredClone(op.value);
        continue;
      }
      const key = keys.pop(),
        p = lookup(body, keys);
      if (p === null || typeof p !== 'object') throw Error('Parent must be an object or array.');
      if (Array.isArray(p)) {
        const pos = indexOf(p, key, op.op === 'add');
        p.splice(
          pos,
          op.op === 'add' ? 0 : 1,
          ...(op.op === 'remove' ? [] : [structuredClone(op.value)]),
        );
      } else {
        if (!Object.hasOwn(p, key) && op.op !== 'add') throw Error('Patch path not found.');
        if (op.op === 'remove') delete p[key];
        else
          Object.defineProperty(p, key, {
            value: structuredClone(op.value),
            enumerable: true,
            writable: true,
            configurable: true,
          });
      }
    } catch (e) {
      throw Error('Operation ' + (i + 1) + ' (' + op.path + '): ' + e.message);
    }
  }
  if (
    !body ||
    body.model !== source.model ||
    !validRequest(source.protocol, body) ||
    (source.protocol !== 'responses' && body.messages.some((m) => !m || typeof m.role !== 'string'))
  )
    throw Error('A draft requires the original model and valid native protocol input.');
  const id = crypto.randomUUID();
  storage()
    .query('INSERT INTO experiments(id,call_id,created,body) VALUES(?,?,?,?)')
    .run(id, source.call_id, Date.now(), JSON.stringify(body));
  return {
    draft_ref: 'draft:' + id,
    parent_ref: ref,
    trace_ref: 'trace:' + source.call_id,
    paths: ops.filter((o) => o.op !== 'test').map((o) => o.path),
  };
}
export function repeatTrace({ ref, request_key }, upstream) {
  const s = snapshot(ref);
  const id = launch(
    { id: s.call_id, model: s.model, protocol: s.protocol, endpoint: s.endpoint },
    JSON.parse(s.request),
    upstream,
    {
      ref,
      key: request_key,
    },
  );
  return {
    run_ref: 'run:' + id,
    trace_ref: 'trace:' + s.call_id,
    status: storage().query('SELECT status FROM runs WHERE id=?').get(id).status,
  };
}
