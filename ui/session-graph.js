// Shared by the list endpoint and the page, so both name a session row alike.
export function sessionRowId(agent, session) {
  return 'session:' + encodeURIComponent(agent ?? '') + ':' + encodeURIComponent(session);
}

// Git-graph lanes for nodes listed newest first. Lane 0 is the main path.
// Each row says which lanes pass through, which end at it, and whether its own
// lane continues up (to a newer child) and down (to its parent).
export function laneLayout(nodes) {
  const lanes = [],
    rows = [];
  let width = 1;
  for (const node of nodes) {
    const waiting = [];
    lanes.forEach((id, i) => id === node.id && waiting.push(i));
    let lane;
    if (node.main) lane = 0;
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
