// Shared by the list endpoint and the page, so both name a session row alike.
export function sessionRowId(agent, session) {
  return 'session:' + encodeURIComponent(agent ?? '') + ':' + encodeURIComponent(session);
}

// Nodes are ordered by request start time, newest first. Replays attach to their
// source for inspection but only a captured request moves the active branch.
export function activeBranch(nodes) {
  const parents = new Map(nodes.map(node => [node.id, node.parent]));
  const active = new Set();
  let id = nodes.find(node => node.entry_type === 'capture')?.id;
  while (id != null && !active.has(id)) {
    active.add(id);
    id = parents.get(id);
  }
  return active;
}

// Git-graph lanes for nodes listed newest first. Lane 0 is the active branch.
// Each row says which lanes pass through, which end at it, and whether its own
// lane continues up (to a newer child) and down (to its parent).
export function laneLayout(nodes, active) {
  const lanes = [],
    rows = [];
  let width = 1;
  for (const node of nodes) {
    const waiting = [];
    lanes.forEach((id, i) => id === node.id && waiting.push(i));
    let lane;
    if (active.has(node.id)) lane = 0;
    else if (waiting.some((i) => i > 0)) lane = waiting.find((i) => i > 0);
    else {
      lane = lanes.findIndex((id, i) => i > 0 && id == null);
      if (lane < 0) lane = Math.max(1, lanes.length);
    }
    const merges = waiting.filter((i) => i !== lane);
    const through = [];
    lanes.forEach((id, i) => id != null && i !== lane && !merges.includes(i) && through.push(i));
    for (const i of merges) lanes[i] = null;
    rows.push({ lane, through, merges, up: waiting.includes(lane), down: node.parent != null });
    lanes[lane] = node.parent ?? null;
    while (lanes.length && lanes.at(-1) == null) lanes.pop();
    width = Math.max(width, lane + 1, lanes.length, ...through.map((i) => i + 1));
  }
  return { rows, width };
}
