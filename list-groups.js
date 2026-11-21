import { sessionRowId } from './ui/session-graph.js';

const captureFrom = 'FROM calls c INDEXED BY calls_list';
const replayFrom = `FROM runs r INDEXED BY runs_list JOIN experiments e INDEXED BY experiments_list
  ON e.id=r.experiment_id JOIN calls c INDEXED BY calls_list ON c.id=e.call_id`;
const captureHeader = "'capture' AS entry_type,c.rowid AS seq,c.id,c.session,c.agent,c.model,c.protocol,c.started,c.ended,c.status,c.preview_version";
const replayHeader = "'repeater' AS entry_type,r.rowid AS seq,r.id,c.session,c.agent,coalesce(r.model,c.model) AS model,c.protocol,r.started,r.ended,r.status,r.preview_version";
const captureBytes = 'octet_length(c.request) AS bytes';
const replayBytes = "CASE WHEN r.kind='baseline' THEN octet_length(c.request) ELSE octet_length(e.body) END AS bytes";
const captureEvent = `SELECT ${captureHeader},c.id AS call_id,c.rowid AS call_seq,
  c.endpoint,c.last_role,c.last_preview,c.final_preview,${captureBytes} ${captureFrom}`;
const replayEvent = `SELECT ${replayHeader},c.id AS call_id,c.rowid AS call_seq,c.endpoint,
  CASE WHEN r.kind='baseline' THEN c.last_role ELSE r.last_role END AS last_role,
  CASE WHEN r.kind='baseline' THEN c.last_preview ELSE r.last_preview END AS last_preview,
  r.final_preview,${replayBytes} ${replayFrom}`;

export const timeline = `WITH events AS (${captureEvent} UNION ALL ${replayEvent})`;
export const listFilter = "WHERE (?='' OR entry_type=?) AND (?='' OR (CASE status WHEN 'checking_unknown' THEN 'checking' ELSE status END)=?)";

export function pageRows(db, order, direction, args, offset) {
  const ranking = `${order} ${direction},started DESC,entry_type DESC,seq DESC`;
  const withBytes = order === 'bytes';
  const rows = db.query(`WITH events AS (
    SELECT ${captureHeader}${withBytes ? ', ' + captureBytes : ''} ${captureFrom}
    UNION ALL
    SELECT ${replayHeader}${withBytes ? ', ' + replayBytes : ''} ${replayFrom}
  ), ranked AS (
    SELECT *,
      row_number() OVER (session_group ORDER BY ${ranking}) AS rank,
      first_value(id) OVER newest AS latest_id,
      first_value(entry_type) OVER newest AS latest_type,
      min(started) OVER session_group AS first,
      count(*) FILTER (WHERE entry_type='capture') OVER session_group AS requests,
      count(*) FILTER (WHERE entry_type='repeater') OVER session_group AS replays,
      count(*) FILTER (WHERE status NOT IN ('pending','checking','checking_unknown','queued','running')) OVER session_group AS settled,
      count(*) FILTER (WHERE preview_version<>0) OVER session_group AS previewed,
      count(*) FILTER (WHERE entry_type='repeater' AND status='queued') OVER session_group AS queued,
      count(*) FILTER (WHERE entry_type='repeater' AND status='running') OVER session_group AS running
    FROM events ${listFilter}
    WINDOW session_group AS (PARTITION BY coalesce(agent,''),session,
      CASE WHEN session='' THEN entry_type END,CASE WHEN session='' THEN seq END),
      newest AS (session_group ORDER BY started DESC,seq DESC,${ranking})
  ), groups AS (
    SELECT * FROM ranked WHERE rank=1
  ), page AS (
    SELECT * FROM groups ORDER BY ${ranking} LIMIT 100 OFFSET ?
  )
  SELECT page.*, totals.total FROM (SELECT count(*) AS total FROM groups) totals
  LEFT JOIN page ON 1 ORDER BY ${ranking}`).all(...args, offset);
  const capture = db.query(`${captureEvent} WHERE c.id=?`);
  const replay = db.query(`${replayEvent} WHERE r.id=?`);
  const calls = [];
  for (const row of rows) {
    if (!row.id) continue;
    const latest = (row.latest_type === 'capture' ? capture : replay).get(row.latest_id);
    if (!row.session) {
      calls.push(latest);
      continue;
    }
    calls.push({
      entry_type: 'session',
      id: sessionRowId(row.agent, row.session),
      agent: row.agent,
      session: row.session,
      protocol: row.protocol,
      first: row.first,
      last: latest.started,
      latest,
      requests: row.requests,
      replays: row.replays,
      settled: row.settled,
      previewed: row.previewed,
      queued: row.queued,
      running: row.running,
      matches: [],
      started: latest.started,
      status: latest.status,
      model: latest.model,
    });
  }
  return { calls, total: rows[0].total };
}

// Collapse requests that share a session ID into one row, at the position of
// its best-ranked member in the current sort order. Full-text search already
// visits each candidate in the worker, so group the matches there.

export function groupRows(rows) {
  const entries = [],
    groups = new Map();
  for (const row of rows) {
    if (!row.session) {
      entries.push(row);
      continue;
    }
    const id = sessionRowId(row.agent, row.session);
    let group = groups.get(id);
    if (!group) {
      group = {
        entry_type: 'session',
        id,
        agent: row.agent,
        session: row.session,
        protocol: row.protocol,
        first: row.started,
        last: row.started,
        latest: row,
        requests: 0,
        replays: 0,
        settled: 0,
        previewed: 0,
        queued: 0,
        running: 0,
        matches: [],
      };
      groups.set(id, group);
      entries.push(group);
    }
    if (!['pending','checking','checking_unknown','queued','running'].includes(row.status)) group.settled++;
    if (row.preview_version) group.previewed++;
    if (row.entry_type === 'repeater') {
      group.replays++;
      if (row.status === 'queued' || row.status === 'running') group[row.status]++;
    } else group.requests++;
    group.first = Math.min(group.first, row.started);
    const latest = group.latest;
    if (row.started > latest.started || (row.started === latest.started && row.seq > latest.seq)) {
      group.last = row.started;
      group.latest = row;
    }
    if (row.hit !== undefined) group.matches.push({ id: row.id, entry_type: row.entry_type, hit: row.hit });
  }
  for (const group of groups.values()) {
    Object.assign(group, {
      started: group.last,
      status: group.latest.status,
      model: group.latest.model,
    });
  }
  return entries;
}
