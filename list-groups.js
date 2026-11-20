import { sessionRowId } from './ui/session-graph.js';

// Collapse requests that share a session ID into one row, at the position of
// its best-ranked member in the current sort order.

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
    if (row.ended != null) group.settled++;
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
    if (row.hit !== undefined) group.matches.push({ id: row.id, hit: row.hit });
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
