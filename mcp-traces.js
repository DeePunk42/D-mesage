import { storage, reconcile, checkLegacyOutcome } from './store.js';
import { timeline } from './list-groups.js';
import { valueAt } from './trace-api.js';
import { requestEntries } from './ui/protocols.js';
import { pointer } from './ui/search.js';
import { recoverCodexOutput } from './codex-reply.js';
import { sessionGroupTitle } from './session-titles.js';

const refOf = (row) => (row.entry_type === 'repeater' ? 'run:' : 'trace:') + row.id;
const unfinished = new Set(['pending', 'checking', 'checking_unknown', 'queued', 'running']);

export function boundedValue(value, { char_offset = 0, max_chars = 24000 } = {}) {
  const encoded = JSON.stringify(value);
  if (char_offset > encoded.length) throw Error('Invalid character offset.');
  if (!char_offset && encoded.length <= max_chars) return { value };
  const end = Math.min(char_offset + max_chars, encoded.length);
  return {
    json_fragment: encoded.slice(char_offset, end),
    char_offset,
    total_chars: encoded.length,
    next_char_offset: end < encoded.length ? end : null,
  };
}

function publicRow(row) {
  const { id, seq, entry_type, session, hit, ...rest } = row;
  const table = entry_type === 'capture' ? 'calls' : 'runs';
  const info = storage()
    .query(
      `SELECT request_tools,response_tools,reply IS NOT NULL AS captured FROM ${table} WHERE id=?`,
    )
    .get(id);
  return {
    ...rest,
    ref: refOf(row),
    number: seq,
    kind: entry_type === 'capture' ? 'capture' : 'replay',
    has_response: !!info?.captured,
    tool_names: toolsOf(info),
    session_id: session || null,
    ...(hit && {
      hit: { side: hit.side, path: hit.path.length ? pointer(hit.path) : '', preview: hit.preview },
    }),
  };
}
function toolsOf(row) {
  return [
    ...new Set([
      ...JSON.parse(row?.request_tools || '[]'),
      ...JSON.parse(row?.response_tools || '[]'),
    ]),
  ];
}

export async function findTraces(args, { search, titleFor }) {
  reconcile();
  const { limit = 25, offset = 0, group_by = 'record', after_capture, query = '' } = args;
  if (after_capture !== undefined && (offset || group_by !== 'record' || args.kind === 'replay'))
    throw Error('after_capture requires capture records and cannot use an offset.');
  const filters = [],
    values = [];
  function filter(column, value) {
    if (value !== undefined) {
      filters.push(column);
      values.push(value);
    }
  }
  filter('agent=?', args.agent);
  filter('session=?', args.session_id);
  filter('status=?', args.status);
  filter('seq=?', args.number);
  filter('started>=?', args.since);
  filter('started<=?', args.until);
  filter('seq>?', after_capture);
  filter(
    'entry_type=?',
    after_capture !== undefined ? 'capture' : args.kind === 'replay' ? 'repeater' : args.kind,
  );
  const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
  const sql = `${timeline} SELECT * FROM events${where} ORDER BY ${after_capture !== undefined ? 'seq ASC' : 'started DESC,entry_type DESC,seq DESC'}`;
  const db = storage();
  let rows, more;
  if (query.trim() || group_by === 'session') {
    const page = await search.find({
      sql,
      args: values,
      q: query,
      offset,
      limit,
      flat: group_by === 'record',
      hitOffset: args.hit_offset ?? 0,
      hitLimit: args.hit_limit ?? 3,
    });
    rows = page.calls;
    more = page.more;
  } else {
    rows = db.query(sql + ' LIMIT ? OFFSET ?').all(...values, limit + 1, offset);
    more = rows.length > limit;
    if (more) rows.pop();
  }
  const records = await Promise.all(
    rows.map(async (row) => {
      if (row.entry_type !== 'session') {
        const name = row.session && await titleFor(row.agent, row.session);
        return { ...publicRow(row), session_title: name || null };
      }
      return {
        kind: 'session',
        agent: row.agent,
        session_id: row.session,
        session_title: (await sessionGroupTitle(db, row, titleFor)) || null,
        requests: row.requests,
        replays: row.replays,
        latest: publicRow(row.latest),
        ...(query && {
          matches: row.matches.slice(0, limit).map((m) => ({
            ref: refOf(m),
            side: m.hit?.side,
            path: m.hit ? pointer(m.hit.path) : null,
            preview: m.hit?.preview,
          })),
          match_count: row.matches.length,
        }),
      };
    }),
  );
  return {
    records,
    has_more: more,
    ...(after_capture !== undefined
      ? { cursor: rows.at(-1)?.seq ?? after_capture }
      : { next_offset: more ? offset + rows.length : null }),
  };
}

export async function readTrace(args, { titleFor, sessionPages }) {
  const { ref, view = 'summary', path = '', wait_ms = 0, before } = args;
  if (wait_ms && view !== 'summary') throw Error('wait_ms applies to summary.');
  const [kind, id] = ref.split(':'),
    capture = kind === 'trace',
    db = storage();
  if (capture) checkLegacyOutcome(db, id);
  reconcile();
  const from = capture
    ? 'FROM calls c WHERE c.id=?'
    : 'FROM runs r JOIN experiments e ON e.id=r.experiment_id JOIN calls c ON c.id=e.call_id WHERE r.id=?';
  const alias = capture ? 'c' : 'r';
  const summary = db.query(`SELECT c.id AS call_id,c.agent,c.session,c.protocol,c.endpoint,
    ${capture ? 'c.model' : 'coalesce(r.model,c.model)'} AS model,${alias}.rowid AS number,
    ${['status', 'started', 'ended', 'last_role', 'last_preview', 'final_preview', 'failure', 'request_tools', 'response_tools'].map((k) => alias + '.' + k).join(',')},
    ${alias}.reply IS NOT NULL AS has_response ${from}`);
  const until = Date.now() + wait_ms;
  let row;
  for (;;) {
    row = summary.get(id);
    if (!row) throw Error('Record not found.');
    if (!unfinished.has(row.status) || Date.now() >= until) break;
    await Bun.sleep(Math.min(150, until - Date.now()));
  }
  const { session, call_id, failure, request_tools, response_tools, ...rest } = row;
  const meta = {
    ...rest,
    ref,
    trace_ref: 'trace:' + call_id,
    session_id: session || null,
    session_title: session ? (await titleFor(row.agent, session)) || null : null,
    has_response: !!row.has_response,
    tool_names: toolsOf({ request_tools, response_tools }),
    terminal: !unfinished.has(row.status),
    failure: JSON.parse(failure),
  };
  if (view === 'summary') return { ...meta, ...boundedValue(valueAt(meta, path), args) };
  const response = view === 'response' || view === 'recovered_output';
  const field = response
    ? alias + '.reply'
    : capture
      ? 'c.request'
      : "CASE WHEN r.kind='baseline' THEN c.request ELSE e.body END";
  const { body } = db.query(`SELECT ${field} AS body ${from}`).get(id);
  let value;
  if (view === 'recovered_output') {
    value = {
      source: 'local_codex_log',
      items: capture ? await recoverCodexOutput({ ...row, id, reply: body }) : [],
    };
  } else if (view === 'messages' || view === 'turn') {
    let entries = requestEntries(row.protocol, JSON.parse(body));
    if (view === 'turn' && capture && session) {
      const { node } = await sessionPages.find({ agent: row.agent, session, focus: id });
      if (node?.parent)
        entries = entries.filter(
          (e) =>
            e.key === (row.protocol === 'responses' ? 'input' : 'messages') &&
            (e.index ?? 0) >= node.kept,
        );
    }
    const end = before ?? entries.length;
    if (end > entries.length) throw Error('Invalid message cursor.');
    const start = Math.max(0, end - 40);
    value = {
      messages: entries.slice(start, end).map((e) => ({
        path: '/' + e.key + (e.index == null ? '' : '/' + e.index),
        message: e.message,
      })),
      next_before: start || null,
      total: entries.length,
    };
  } else value = JSON.parse(body);
  return { ...meta, view, ...boundedValue(valueAt(value, path), args) };
}
