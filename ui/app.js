import { toolLookup, phaseLabel } from './response-items.js';
import {
  protocolNames,
  requestEntries,
  responseMessages,
  isTextBlock,
  validRequest,
  writeEntry,
  removeEntry,
  insertEntry,
} from './protocols.js';
import { messagePreview, pairingWarning, prettyEditorText } from './messages.js';
import {
  el,
  button,
  roleBadge,
  icon,
  textBlock,
  blockData,
  highlightedEditor,
  jsonTree,
  showText,
  messageCard,
  sectionTitle,
  pretty,
} from './views.js';
import { draftWriter } from './tab-save.js';
import { searchConditions, rankedHits, pointer } from './search.js';
import { filterBox } from './filter-box.js';
import { changesView } from './changes.js';
import { activeBranch, laneLayout, sessionRowId } from './session-graph.js';
import { modelPicker } from './model-picker.js';
const $ = (id) => document.getElementById(id);
// The launcher has already paired this frame. After navigating to the page
// service, ask Magpie for its appearance again and follow live theme changes.
if (window.parent !== window) {
  const requestId = 'd-message-appearance';
  const colors = ['bg', 'card', 'fg', 'fg-2', 'line', 'accent', 'accent-soft', 'accent-fg', 'green', 'red', 'amber'];
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.magpie !== 1) return;
    const msg = event.data;
    const theme = msg.event === 'theme' ? msg.data : msg.id === requestId ? msg.result : null;
    if (typeof theme?.dark !== 'boolean') return;
    const root = document.documentElement;
    root.dataset.theme = theme.dark ? 'dark' : 'light';
    for (const name of [...colors, 'font', 'code']) {
      const value = theme.tokens?.[name];
      const property = colors.includes(name) ? 'color' : 'font-family';
      if (typeof value === 'string' && CSS.supports(property, value))
        root.style.setProperty('--magpie-' + name, value);
      else root.style.removeProperty('--magpie-' + name);
    }
  });
  window.parent.postMessage({ magpie: 1, method: 'theme', id: requestId }, '*');
}
const entryParams = new URLSearchParams(location.hash.slice(1));
const entryKey = entryParams.get('access');
const access =
  entryKey || entryParams.get('resume') || history.state?.dMessageResume || history.state?.traceforkResume || '';
async function prepareReload() {
  if (!entryKey) return;
  const { token } = await api('reload-token', {});
  try {
    history.replaceState({ dMessageResume: token }, '', location.pathname + location.search);
  } catch {
    // Opaque Magpie frames may reject history APIs. Keep only the expiring
    // page credential in the fragment, which is never sent in a request URL.
    location.replace('#resume=' + encodeURIComponent(token));
  }
}
const time = (t) => new Date(t).toLocaleTimeString('en', { hour12: false });
const statusName = {
  complete: 'Complete',
  pending: 'Pending',
  incomplete: 'Incomplete',
  queued: 'Queued',
  running: 'Running',
  canceled: 'Canceled',
  interrupted: 'Interrupted',
  failed: 'Failed',
  draft: 'Saved draft',
};
function traceStatus(row) {
  if (row.entry_type === 'capture' && row.status === 'incomplete' && row.ended == null)
    return 'Completion unconfirmed';
  return statusName[row.status] || row.status;
}
const explain = (e) => {
  $('notice').textContent = e.message || String(e);
};
const invoke =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      explain(e);
    }
  };
async function api(path, body, keepalive = false) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(new URL('api/' + path, location.href), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + access,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: payload,
    keepalive: keepalive && new Blob([payload]).size < 60000,
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error || 'Request failed');
  return data;
}
let workspace = 'trace',
  selected = null,
  source = null,
  draft = null,
  dirty = false,
  posting = false;
let hTab = 'Messages',
  dTab = 'Messages',
  rTab = 'Answer',
  runId = 'original',
  snapshot = null,
  runs = [],
  saved = [];
let offset = 0,
  sort = 'time',
  asc = false,
  recording = false,
  rows = [],
  rowSignature = '',
  listQuery = '',
  listEpoch = 0,
  detailEpoch = 0,
  runEpoch = 0;
let openMessages = new Set();
let undoStack = [],
  redoStack = [],
  cleanDraft = null;
let field = null,
  typing = false;
const tabUndo = new Map();
let writer = null,
  switching = false,
  restoring = false;
function markDraft() {
  if (!restoring) writer?.mark();
}
modelPicker({
  menu: $('modelMenu'), search: $('modelSearch'), list: $('modelChoices'),
  load: () => api('models'), current: () => draft?.model, original: () => source?.original_model,
  pick(model) {
    if (!draft || model === draft.model || field?.error) return;
    const previous = viewState();
    undoStack.push(previous);
    redoStack = [];
    const body = { ...draft, model };
    const nextField = field?.key === 'request' ? { ...field, text: pretty(body) } : field;
    applyView({ ...previous, draft: body, field: nextField });
  },
});
function viewState() {
  return { draft, field: field && { ...field }, open: new Set(openMessages), tab: dTab };
}
function applyView(state) {
  draft = state.draft;
  field = state.field || null;
  typing = false;
  openMessages = new Set(state.open);
  dTab = state.tab;
  dirty = draft !== cleanDraft || !!field?.error;
  renderDraft();
  markDraft();
}
function commit(body, index, tab = dTab, nextField = null) {
  undoStack.push(viewState());
  redoStack = [];
  applyView({ draft: body, field: nextField, open: [index], tab });
  $('draftView')
    .querySelector('[data-index="' + index + '"]')
    ?.scrollIntoView({ block: 'nearest' });
}
let entriesBody, entriesProtocol, cachedEntries;
function draftEntries() {
  if (entriesBody !== draft || entriesProtocol !== source.protocol) {
    entriesBody = draft;
    entriesProtocol = source.protocol;
    cachedEntries = requestEntries(entriesProtocol, draft);
  }
  return cachedEntries;
}
function deleteMessage(index) {
  const entries = draftEntries();
  commit(removeEntry(draft, entries[index]), Math.min(index, entries.length - 2));
}
function updateMessage(index, fn) {
  const m = structuredClone(draftEntries()[index].message);
  fn(m);
  commit(replaceMessage(index, m), index);
}
function stepHistory(from, to) {
  if (!from.length) return;
  to.push(viewState());
  const state = from.pop();
  applyView(dTab === 'Changes' ? { ...state, tab: 'Changes' } : state);
}
$('undo').onclick = () => stepHistory(undoStack, redoStack);
$('redo').onclick = () => stepHistory(redoStack, undoStack);
let viewWrite = Promise.resolve();
function setWorkspace(tab, remember = false) {
  if (remember && tab !== workspace)
    viewWrite = viewWrite.then(() => api('tabs/view', { view: tab })).catch(explain);
  workspace = tab;
  for (const id of ['scopeMenu', 'filterMenu', 'metaMenu', 'tabMenu', 'modelMenu']) $(id).open = false;
  $('settings').hidden = tab !== 'settings';
  $('toSettings').setAttribute('aria-pressed', tab === 'settings');
  $('mcpHint').textContent = '';
  $('mcpToken').hidden = true;
  $('mcpToken').value = '';
  $('mcpReveal').textContent = 'Show token';
  $('trace').hidden = tab !== 'trace';
  $('repeat').hidden = tab !== 'repeater';
  $('toTrace').setAttribute('aria-pressed', tab === 'trace');
  $('toRepeat').setAttribute('aria-pressed', tab === 'repeater');
  $('noDraft').hidden = !!draft;
  $('studio').hidden = !draft;
}
function paintMcp(config) {
  $('mcpEnabled').checked = config.enabled;
  $('mcpPort').value = config.port;
  $('mcpUrl').value = config.url;
  $('mcpStatus').dataset.state = config.error ? 'error' : config.listening ? 'on' : 'off';
  $('mcpStatus').textContent =
    config.error || (config.listening ? 'Listening on 127.0.0.1' : 'Listener off');
  $('mcpCopy').disabled = !config.listening;
}
$('toSettings').onclick = invoke(async () => {
  setWorkspace('settings', true);
  paintMcp(await api('settings/mcp'));
});
$('mcpForm').onsubmit = invoke(async (e) => {
  e.preventDefault();
  $('mcpApply').disabled = true;
  try {
    paintMcp(
      await api('settings/mcp', {
        enabled: $('mcpEnabled').checked,
        port: Number($('mcpPort').value),
      }),
    );
    $('notice').textContent = '';
  } catch (error) {
    paintMcp(await api('settings/mcp'));
    throw error;
  } finally {
    $('mcpApply').disabled = false;
  }
});
$('mcpReveal').onclick = invoke(async () => {
  const input = $('mcpToken');
  if (input.hidden) {
    input.value = (await api('settings/mcp/token', {})).token;
    input.hidden = false;
    input.select();
    $('mcpReveal').textContent = 'Hide token';
  } else {
    input.value = '';
    input.hidden = true;
    $('mcpReveal').textContent = 'Show token';
  }
});
$('mcpCopy').onclick = invoke(async () => {
  const token = (await api('settings/mcp/token', {})).token;
  const config = {
    mcpServers: {
      'd-message': {
        type: 'http',
        url: $('mcpUrl').value,
        headers: { Authorization: 'Bearer ' + token },
      },
    },
  };
  try {
    await navigator.clipboard.writeText(pretty(config));
    $('mcpHint').textContent = 'Client configuration copied.';
  } catch {
    copyDialog('Copy MCP client configuration', pretty(config));
  }
});
function tabs(id, values, current, select) {
  $(id).replaceChildren(
    ...values.map((v) => {
      const b = button(v, () => select(v));
      b.setAttribute('aria-pressed', v === current);
      return b;
    }),
  );
}
function confirmAction(msg, label, destructive = false) {
  const dlg = $('confirmDialog');
  if (dlg.open) return Promise.resolve(false);
  $('confirmMsg').textContent = msg;
  $('confirm').textContent = label;
  $('confirm').classList.toggle('danger', destructive);
  dlg.returnValue = '';
  return new Promise((resolve) => {
    const finish = (ok) => {
      dlg.oncancel = null;
      dlg.close();
      resolve(ok);
    };
    $('keep').onclick = () => finish(false);
    $('confirm').onclick = () => finish(true);
    dlg.oncancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    dlg.showModal();
  });
}
function copyDialog(title, value) {
  $('editTitle').textContent = title;
  $('editValue').value = value;
  $('cancelEdit').textContent = 'Close';
  $('editDialog').showModal();
  $('editValue').focus();
  $('editValue').select();
}
$('cancelEdit').onclick = () => $('editDialog').close();
function jsonPanel(value, editFn, hit) {
  const panel = el('div'),
    actions = el('div', '', 'jsonActions'),
    tree = jsonTree(value, null, hit);
  actions.append(
    button('Collapse all', () => tree.querySelectorAll('details').forEach((d) => (d.open = false))),
    button('Expand root', () => {
      const d = tree.querySelector('details');
      if (d) d.open = true;
    }),
    button('Copy JSON', async () => {
      try {
        await navigator.clipboard.writeText(pretty(value));
      } catch {
        copyDialog('Copy JSON · ⌘/Ctrl + C', pretty(value));
      }
    }),
  );
  if (editFn) actions.append(button('Edit JSON', editFn));
  panel.append(actions, tree);
  return panel;
}
function parseCall(c) {
  return { ...c, body: JSON.parse(c.request), response: c.reply ? JSON.parse(c.reply) : null };
}
let activeHits = [],
  hitIndex = 0,
  hitRecord = '',
  hitQuery = '';
function focusHit(index) {
  hitIndex = index;
  hTab = activeHits[index].side === 'request' ? 'Full JSON' : 'Response';
  inspect();
}
$('hitPrev').onclick = () => focusHit(hitIndex - 1);
$('hitNext').onclick = () => focusHit(hitIndex + 1);
function inspect(scroll = false) {
  if (!selected) return;
  $('emptyInspect').hidden = true;
  $('inspector').hidden = false;
  $('callTitle').textContent =
    selected.entry_type === 'repeater' ? 'Repeater · R' + selected.seq : 'Request #' + selected.seq;
  $('inspectModel').textContent = selected.model;
  $('inspectModel').title = selected.model;
  const facts = [
    [
      selected.entry_type === 'repeater' ? 'Source agent' : 'Agent',
      selected.agent || 'Unknown agent',
    ],
    ['Protocol', protocolNames[selected.protocol || 'chat']],
    ['Endpoint', selected.endpoint],
    ['Model', selected.model],
    ['Session', selected.session],
    ['Original request', selected.entry_type === 'repeater' && '#' + selected.call_seq],
    ['Time', new Date(selected.started).toLocaleString('en', { hour12: false })],
    ['Status', traceStatus(selected)],
    ['Duration', selected.ended != null && selected.ended - selected.started + ' ms'],
  ];
  $('callMeta').replaceChildren(
    ...facts.filter(([, v]) => v).flatMap(([k, v]) => [el('dt', k), el('dd', v)]),
  );
  const views = selected.session
    ? ['This turn', 'Messages', 'Full JSON', 'Response']
    : ['Messages', 'Full JSON', 'Response'];
  if (!views.includes(hTab)) hTab = 'Messages';
  tabs('histTabs', views, hTab, (v) => {
    hTab = v;
    inspect(true);
  });
  const box = $('inspectView');
  box.replaceChildren();
  const hit = activeHits[hitIndex];
  const focused = hit && (hit.side === 'request' ? hTab === 'Full JSON' : hTab === 'Response');
  $('hitBar').hidden = !focused;
  if (focused) {
    $('hitPath').textContent = hit.side + ' ' + pointer(hit.path);
    $('hitCount').textContent = hitIndex + 1 + ' / ' + activeHits.length;
    $('hitPrev').disabled = hitIndex === 0;
    $('hitNext').disabled = hitIndex === activeHits.length - 1;
    box.append(
      jsonPanel(hit.side === 'request' ? selected.body : selected.response, null, {
        ...hit,
      }),
    );
    requestAnimationFrame(() =>
      box.querySelector('.searchTarget mark')?.scrollIntoView({ block: 'nearest' }),
    );
  } else if (hTab === 'Full JSON') box.append(jsonPanel(selected.body));
  else if (hTab === 'This turn') renderTurn(box);
  else if (hTab === 'Response') {
    if (selected.response != null)
      box.append(responseContent(selected.response, selected.protocol, true));
    else box.append(noReply());
    if (scroll) box.scrollTop = 0;
  } else {
    const msgs = requestEntries(selected.protocol, selected.body).map((entry) => entry.message);
    const lookup = toolLookup(msgs);
    msgs.forEach((m, i) => box.append(messageCard(m, i, i === msgs.length - 1, null, lookup)));
    if (scroll && box.lastElementChild)
      box.scrollTop = box.lastElementChild.offsetTop - box.offsetTop;
  }
}
function queuedMessage(id, refresh) {
  const box = el('div', '', 'hint');
  box.append(
    el('p', 'Waiting for a replay slot…'),
    button(
      'Cancel queued run',
      invoke(async () => {
        try {
          await api('cancel/' + id, {});
        } finally {
          await refresh();
        }
      }),
    ),
  );
  return box;
}
function noReply() {
  if (selected.status === 'queued') return queuedMessage(selected.id, list);
  return el(
    'p',
    selected.error ||
      {
        canceled: 'Canceled before sending.',
        pending: 'Waiting for a response…',
        running: 'Waiting for a response…',
        incomplete:
          selected.entry_type === 'capture' && selected.ended == null
            ? 'The capture ended without a completion callback. The model outcome is unknown.'
            : 'No complete response was captured.',
        failed: 'The request failed before a response was saved.',
      }[selected.status] ||
      'No response body was saved.',
    'hint',
  );
}
const trees = new Map();
let activeGroup = null,
  activeOnly = false;
let rowIndex = new Map();
const kindLabel = { retry: 'Retry', compacted: 'Possible compaction', branch: 'Branch', replay: 'Repeater' };
const nodeRef = (n) => (n ? (n.entry_type === 'repeater' ? 'R' : '#') + n.seq : '');
function describeNode(n, byId) {
  const p = byId.get(n.parent),
    ref = nodeRef(p);
  const kept = p ? `kept ${n.kept} of ${p.items} items · +${n.added}` : '';
  return {
    root: n.main ? `Session start · ${n.items} items` : `Separate conversation · ${n.items} items`,
    turn: `After ${ref} · +${n.added} items`,
    retry: `Same request as ${ref}`,
    compacted: `Shortened prefix after ${ref} · ${kept}`,
    branch: `Branched from ${ref} · ${kept}`,
    replay: `Repeater run of ${ref}`,
  }[n.kind];
}
function treeSignature(g) {
  return [g.requests, g.replays, g.queued, g.running, g.settled, g.previewed, g.activitySeq, g.last, g.latest.status, g.latest.ended].join('|');
}
async function ensureTree(id, agent, session, sig) {
  const cached = trees.get(id);
  if (cached && (cached.sig === sig || cached.loading)) return;
  trees.set(id, { ...cached, sig, loading: true });
  try {
    const data = await api('sessions/tree?' + new URLSearchParams({ agent: agent ?? '', session }));
    trees.set(id, { sig, nodes: data.nodes, byId: new Map(data.nodes.map((n) => [n.id, n])) });
  } catch (error) {
    trees.delete(id);
    throw error;
  }
  if (activeGroup?.id === id) paintTree();
  const node = trees.get(id).byId.get(selected?.id);
  if (node && (node.status !== selected.status || node.ended !== selected.ended)) {
    const c = await loadEvent(node.id, node.entry_type);
    if (c.id === selected?.id) {
      selected = parseCall(c);
      inspect();
    }
  } else if (node && hTab === 'This turn') inspect();
}
function treeEntry(id) {
  for (const [gid, tree] of trees) {
    const n = tree.byId?.get(id);
    if (n)
      return {
        id,
        entry_type: n.entry_type,
        hit: rowIndex.get(gid)?.matches.find((m) => m.id === id)?.hit ?? null,
      };
  }
}
function previewLine(r, hit) {
  const line = el('span', '', 'eventPreview');
  if (hit) {
    line.append(el('small', hit.side), el('span', hit.preview, 'snippet'));
    line.title = pointer(hit.path);
  } else {
    line.append(roleBadge(r.last_role));
    if (r.last_role === 'tool') line.append(icon('wrench'));
    line.append(el('span', r.last_preview || '—', 'snippet'));
    if (r.final_preview != null) {
      line.append(el('small', 'Final answer', 'phaseBadge'));
      if (r.final_preview) line.append(el('span', r.final_preview, 'snippet'));
    }
    line.title = [r.last_preview, r.final_preview].filter(Boolean).join(' · ');
  }
  if (r.status !== 'complete')
    line.append(el('small', traceStatus(r), 'eventStatus ' + r.status));
  return line;
}
function flatRow(r) {
  const row = el('button', '', 'eventRow');
  row.dataset.id = r.id;
  row.setAttribute('aria-current', String(r.id === selected?.id));
  const top = el('span', '', 'eventTop');
  const replay = r.entry_type === 'repeater';
  top.append(el('small', replay ? 'R' + r.seq + ' ← #' + r.call_seq : '#' + r.seq));
  if (replay) top.append(el('span', 'Repeater', 'replayBadge'));
  const title = el('b', r.agent || 'Unknown agent');
  title.title = title.textContent;
  top.append(title, el('time', time(r.started)));
  row.title = [traceStatus(r), replay && 'Original request #' + r.call_seq, r.session]
    .filter(Boolean)
    .join(' · ');
  row.append(top, previewLine(r, r.hit));
  row.onclick = invoke(async () => {
    await select(r.id);
    $('trace').classList.add('showDetail');
  });
  row.ondblclick = invoke(() => select(r.id, true));
  return row;
}
async function activateSession(g) {
  activeGroup = g;
  paintRows();
  paintTree();
  await select(g.latest.id);
  $('trace').classList.add('showDetail');
}
function sessionRow(g) {
  const row = el('button', '', 'eventRow sessionRow');
  row.dataset.id = g.id;
  row.setAttribute('aria-current', String(activeGroup?.id === g.id));
  const top = el('span', '', 'eventTop');
  const title = el('b', g.title || 'Session');
  title.title = g.title || '';
  top.append(el('span', '', 'sessionMark'), title, el('time', time(g.last)));
  const meta = el('span', '', 'eventPreview sessionMeta');
  meta.append(el('span', sessionCounts(g), 'snippet'));
  if (g.status !== 'complete')
    meta.append(el('small', traceStatus(g.latest), 'eventStatus ' + g.status));
  row.title = 'Session ' + g.session;
  row.append(top, meta);
  row.onclick = invoke(() => activateSession(g));
  return row;
}
function sessionCounts(g) {
  return [
    agentName(g.agent),
    g.requests + (g.requests === 1 ? ' request' : ' requests'),
    g.replays && g.replays + (g.replays === 1 ? ' replay' : ' replays'),
    g.matches.length && g.matches.length + (g.matches.length === 1 ? ' match' : ' matches'),
  ]
    .filter(Boolean)
    .join(' · ');
}
const LANE = 12;
function laneGutter(lane, width, flipped, n) {
  const ns = 'http://www.w3.org/2000/svg',
    w = width * LANE;
  const box = el('span', '', 'laneGutter');
  box.style.width = w + 'px';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} 100`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  if (flipped) svg.classList.add('flipped');
  const x = (i) => i * LANE + LANE / 2;
  const path = (d, i) => {
    const line = document.createElementNS(ns, 'path');
    line.setAttribute('d', d);
    line.setAttribute('class', i === 0 ? 'mainLane' : 'sideLane');
    svg.append(line);
  };
  for (const i of lane.through) path(`M${x(i)} 0V100`, i);
  for (const i of lane.merges)
    path(`M${x(i)} 0C${x(i)} 35 ${x(lane.lane)} 25 ${x(lane.lane)} 50`, i);
  if (lane.up) path(`M${x(lane.lane)} 0V50`, lane.lane);
  if (lane.down) path(`M${x(lane.lane)} 50V100`, lane.lane);
  const dot = el('span', '', 'laneDot dot-' + (n.side && lane.lane !== 0 ? 'side' : n.kind));
  if (lane.lane === 0) dot.classList.add('onMain');
  dot.style.left = x(lane.lane) + 'px';
  box.append(svg, dot);
  return box;
}
function treeRow(g, n, lane, width, flipped, byId) {
  const hit = g.matches.find((m) => m.id === n.id);
  const row = el('button', '', 'eventRow treeRow');
  if (lane.lane !== 0) row.classList.add('offMain');
  if (hit) row.classList.add('hitRow');
  row.dataset.id = n.id;
  row.setAttribute('aria-current', String(n.id === selected?.id));
  const body = el('span', '', 'treeBody');
  const top = el('span', '', 'eventTop');
  top.append(el('small', nodeRef(n)));
  const side = n.side && lane.lane !== 0;
  const label = side
    ? 'Side'
    : n.kind === 'root' && !n.main
      ? 'Separate'
      : kindLabel[n.kind];
  if (label) top.append(el('span', label, 'kindBadge kind-' + (side ? 'side' : n.kind)));
  top.append(el('span', '', 'grow'), el('time', time(n.started)));
  body.append(top, previewLine(n, hit?.hit));
  row.title = describeNode(n, byId);
  row.append(laneGutter(lane, width, flipped, n), body);
  row.onclick = invoke(async () => {
    await select(n.id);
    $('trace').classList.add('showDetail');
  });
  row.ondblclick = invoke(() => select(n.id, true));
  return row;
}
function paintTree() {
  const g = activeGroup;
  $('traceRight').classList.toggle('noTree', !g);
  const box = $('treeRows');
  if (!g) return box.replaceChildren();
  $('treeTitle').textContent = g.title || 'Session';
  $('treeTitle').title = g.title || '';
  $('treeMeta').textContent = sessionCounts(g);
  $('mainOnly').checked = activeOnly;
  const tree = trees.get(g.id),
    sig = treeSignature(g);
  if (tree?.sig !== sig) void ensureTree(g.id, g.agent, g.session, sig).catch(explain);
  if (!tree?.nodes) return box.replaceChildren(el('p', 'Loading session…', 'hint treeHint'));
  const focus = box.contains(document.activeElement),
    scroll = box.scrollTop;
  let nodes = tree.nodes
    .slice()
    .sort((a, b) => b.started - a.started || (a.entry_type === b.entry_type ? b.seq - a.seq : a.entry_type === 'repeater' ? -1 : 1));
  const active = activeBranch(nodes);
  if (activeOnly) nodes = nodes.filter((n) => active.has(n.id));
  const layout = laneLayout(nodes, active);
  const flipped = sort === 'time' && asc;
  const order = nodes.map((n, i) => [n, layout.rows[i]]);
  if (flipped) order.reverse();
  box.replaceChildren(
    ...order.map(([n, lane]) => treeRow(g, n, lane, layout.width, flipped, tree.byId)),
  );
  box.scrollTop = scroll;
  if (focus) box.querySelector('[aria-current=true]')?.focus({ preventScroll: true });
}
$('mainOnly').onchange = () => {
  activeOnly = $('mainOnly').checked;
  paintTree();
};
function renderTurn(box) {
  const id = sessionRowId(selected.agent, selected.session);
  const tree = trees.get(id),
    node = tree?.byId?.get(selected.id);
  if (!node) {
    box.append(el('p', 'Loading session…', 'hint'));
    if (!tree?.loading)
      void ensureTree(id, selected.agent, selected.session, 'detail').catch(explain);
    return;
  }
  const parent = tree.byId.get(node.parent);
  const head = el('div', '', 'turnHead');
  head.append(el('span', describeNode(node, tree.byId)));
  if (parent) head.append(button('Go to ' + nodeRef(parent), invoke(() => select(parent.id))));
  box.append(head);
  if (node.entry_type === 'repeater')
    box.append(
      el('p', 'This run replays an edited request. Compare edits in Repeater → Changes.', 'hint'),
    );
  else {
    const entries = requestEntries(selected.protocol, selected.body);
    const key = selected.protocol === 'responses' ? 'input' : 'messages';
    const lookup = toolLookup(entries.map((e) => e.message));
    const fresh = entries
      .map((e, i) => [e, i])
      .filter(([e]) => e.key === key && (e.index ?? 0) >= node.kept);
    if (!fresh.length) box.append(el('p', 'No new input items.', 'hint'));
    fresh.forEach(([e, i], k) =>
      box.append(
        messageCard(e.message, i, fresh.length <= 3 || k === fresh.length - 1, null, lookup),
      ),
    );
  }
  box.append(sectionTitle('Reply'));
  box.append(
    selected.response != null ? responseContent(selected.response, selected.protocol) : noReply(),
  );
}
function loadEvent(id, entryType) {
  return api((entryType === 'repeater' ? 'snapshot/' : 'calls/') + id);
}
async function select(id, open = false, jump = true) {
  const epoch = ++detailEpoch;
  const row = rowIndex.get(id) ?? treeEntry(id);
  if (!row || row.entry_type === 'session') return;
  const changed = selected?.id !== id;
  if (selected?.id !== id) {
    const c = await loadEvent(id, row.entry_type);
    if (epoch !== detailEpoch) return;
    selected = parseCall(c);
    hTab = selected.session ? 'This turn' : 'Messages';
    const group = selected.session ? sessionRowId(selected.agent, selected.session) : null;
    if (activeGroup?.id !== group) {
      activeGroup = group ? (rowIndex.get(group) ?? activeGroup) : null;
      if (activeGroup?.id !== group) activeGroup = null;
      paintTree();
    }
    for (const row of $('calls').children)
      row.setAttribute(
        'aria-current',
        String(row.dataset.id === id || (!!group && row.dataset.id === group)),
      );
    for (const row of $('treeRows').children)
      row.setAttribute('aria-current', String(row.dataset.id === id));
  }
  if (changed || hitRecord !== id || hitQuery !== filters.query()) {
    hitRecord = id;
    hitQuery = filters.query();
    activeHits = row.hit
      ? searchConditions(hitQuery).flatMap(query =>
          [...rankedHits(selected.body, selected.response, query, row.hit.kept)])
      : [];
    hitIndex = 0;
  }
  if (jump && activeHits.length) focusHit(hitIndex);
  else if (changed || !jump) inspect(true);
  if (open) await fork();
}
function paintRows() {
  const body = $('calls'),
    focus = body.contains(document.activeElement);
  body.replaceChildren();
  for (const r of rows) {
    if (r.entry_type !== 'session') {
      body.append(flatRow(r));
      continue;
    }
    body.append(sessionRow(r));
  }
  if (focus) body.querySelector('[aria-current=true]')?.focus({ preventScroll: true });
}
let lastClear = 0;
function resetHistory(cursor) {
  activeHits = [];
  hitRecord = hitQuery = '';
  lastClear = cursor;
  listEpoch++;
  runEpoch++;
  detailEpoch++;
  selected = source = draft = cleanDraft = snapshot = field = null;
  dirty = typing = false;
  rows = [];
  runs = [];
  saved = [];
  undoStack = [];
  redoStack = [];
  writer?.dispose();
  writer = null;
  tabUndo.clear();
  paintTabStrip([]);
  openMessages.clear();
  runId = 'original';
  offset = 0;
  listQuery = rowSignature = '';
  for (const id of ['calls', 'inspectView', 'draftView', 'runView', 'runSelect'])
    $(id).replaceChildren();
  delete $('runSelect').dataset.signature;
  $('inspector').hidden = true;
  activeGroup = null;
  trees.clear();
  paintTree();
  $('trace').classList.remove('showDetail');
  setWorkspace(workspace);
}
const agentBrands = new Map([
  ['claude', { name: 'Claude Code', icon: 'claude' }],
  ['codex', { name: 'Codex', icon: 'codex' }],
  ['dsh', { name: 'DeepSeek Harness', icon: 'dsh' }],
]);
const allAgentsName = 'All local agents';
const agentName = (id) => agentBrands.get(id)?.name ?? id;

function agentIcon(id) {
  const badge = el('span', '', 'scopeAvatar');
  badge.setAttribute('aria-hidden', 'true');
  if (!id) badge.append(icon('agents'));
  else {
    const logo = agentBrands.get(id)?.icon;
    const initial = Array.from(agentName(id))[0].toUpperCase();
    if (logo) {
      const image = el('img');
      image.alt = '';
      image.onerror = () => badge.replaceChildren(initial);
      image.src = new URL('icons/' + logo + '.svg', location.href);
      badge.append(image);
    } else badge.textContent = initial;
  }
  return badge;
}

function paintScope(agents) {
  const summary = $('scopeSummary');
  const label =
    agents === 'all' ? allAgentsName : agents.map(agentName).join(', ') || 'Waiting for an agent';
  summary.title = 'Capture scope: ' + label;
  summary.setAttribute('aria-label', summary.title);
  const signature = JSON.stringify(agents);
  if (summary.dataset.agents === signature) return;
  summary.dataset.agents = signature;
  const badges = agents === 'all' || !agents.length ? [null] : agents.slice(0, 4);
  if (Array.isArray(agents) && agents.length > badges.length) badges.push(null);
  summary.replaceChildren(...badges.map(agentIcon));
}
paintScope([]);

function paintRecording(data) {
  if (data.clearedThrough > lastClear) resetHistory(data.clearedThrough);
  recording = data.recording;
  $('record').dataset.on = recording;
  $('record').setAttribute('aria-pressed', String(recording));
  $('record').textContent = recording ? 'Stop recording' : 'Start recording';
  $('record').disabled = false;
  if (data.scope) paintScope(data.scope.agents);
}

function scopeOptions(choices, selected) {
  const group = el('fieldset'),
    options = el('div', '', 'scopeOptions');
  group.append(el('legend', 'Agents'));
  function check(value, parent, checked) {
    const row = el('label'),
      input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    row.append(
      input,
      agentIcon(value),
      document.createTextNode(value ? agentName(value) : allAgentsName),
    );
    parent.append(row);
    return input;
  }
  const all = check(null, group, selected === 'all');
  const picks = new Set(selected === 'all' ? [] : selected);
  function drawOptions() {
    options.replaceChildren();
    for (const name of [...new Set([...choices, ...picks])].sort()) {
      const item = check(name, options, picks.has(name));
      item.onchange = () => {
        all.checked = false;
        if (item.checked) picks.add(name);
        else picks.delete(name);
      };
    }
  }
  all.onchange = () => {
    if (all.checked) {
      picks.clear();
      drawOptions();
    }
  };
  drawOptions();
  const line = el('div', '', 'scopeManual'),
    input = el('input');
  input.placeholder = 'Enter an agent ID';
  input.setAttribute('aria-label', input.placeholder);
  function add() {
    const value = input.value.trim();
    if (!value) return;
    all.checked = false;
    picks.add(value);
    choices = [...new Set([...choices, value])];
    drawOptions();
    input.value = '';
  }
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      add();
    }
  };
  line.append(input, button('Add', add));
  group.append(options, line);
  $('scopeFields').append(group);
  return () => {
    add();
    if (all.checked) return 'all';
    if (!picks.size) throw Error('Select an agent or choose “All local agents”.');
    return [...picks].sort();
  };
}
let menuEpoch = 0;
$('scopeSummary').onclick = invoke(async (e) => {
  e.preventDefault();
  $('scopeMenu').open = !$('scopeMenu').open;
  const epoch = ++menuEpoch;
  if (!$('scopeMenu').open) return;
  $('scopeApply').disabled = true;
  $('scopeFields').replaceChildren();
  $('scopeError').textContent = '';
  const { scope, choices } = await api('capture-scope');
  if (epoch !== menuEpoch || !$('scopeMenu').open) return;
  const agents = scopeOptions(choices.agents, scope.agents);
  $('scopeApply').disabled = false;
  $('scopeApply').onclick = async () => {
    $('scopeApply').disabled = true;
    try {
      const state = await api('capture-scope', {
        agents: agents(),
      });
      paintRecording(state);
      if (epoch === menuEpoch && $('scopeMenu').open) {
        $('scopeMenu').open = false;
        $('scopeSummary').focus();
      }
    } catch (e) {
      $('scopeError').textContent = e.message;
    } finally {
      $('scopeApply').disabled = false;
    }
  };
});
document.addEventListener('pointerdown', (e) => {
  if ($('scopeMenu').open && !$('scopeMenu').contains(e.target)) $('scopeMenu').open = false;
});
$('scopeMenu').onkeydown = (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    $('scopeMenu').open = false;
    $('scopeSummary').focus();
  }
};
async function list() {
  const epoch = ++listEpoch,
    q = filters.query(),
    status = $('statusFilter').value,
    type = $('typeFilter').value;
  const query = new URLSearchParams({
    q,
    status,
    type,
    offset,
    sort,
    asc: asc ? '1' : '0',
  }).toString();
  const data = await api('list?' + query);
  if (epoch !== listEpoch || data.clearedThrough < lastClear) return;
  const oldOffset = offset;
  paintRecording(data);
  if (offset !== oldOffset) return list();
  rows = data.calls;
  rowIndex = new Map();
  for (const r of rows) {
    rowIndex.set(r.id, r);
    if (r.entry_type === 'session')
      rowIndex.set(r.latest.id, {
        ...r.latest,
        hit: r.matches.find((m) => m.id === r.latest.id)?.hit ?? (r.matches.length ? null : undefined),
      });
  }
  const listed = (item) =>
    !!item &&
    (rowIndex.has(item.id) || (!!item.session && rowIndex.has(sessionRowId(item.agent, item.session))));
  if (query !== listQuery && !listed(selected)) {
    detailEpoch++;
    selected = null;
    $('inspector').hidden = true;
    $('emptyInspect').hidden = false;
  }
  const queryChanged = query !== listQuery;
  listQuery = query;
  const paged = !!offset || data.more;
  $('count').textContent = paged
    ? `${offset + 1}–${offset + rows.length} / ${data.total}`
    : `${data.total} ${data.total === 1 ? 'record' : 'records'}`;
  $('clearHistory').disabled = !data.total && !q && !status && !type;
  $('prev').hidden = $('next').hidden = !paged;
  $('filterButton').classList.toggle('inUse', !!status || sort !== 'time' || asc);
  $('filterButton').title = [
    statusName[status] || 'All statuses',
    $('sortField').selectedOptions[0].text,
    asc ? 'Ascending' : 'Descending',
  ].join(' · ');
  if (!selected) $('emptyInspect').hidden = !rows.length;
  $('listEmpty').hidden = !!rows.length;
  $('listEmpty').textContent =
    q || status || type
      ? 'No matching records.'
      : 'No records yet. Start recording to capture requests.';
  $('prev').disabled = !offset;
  $('next').disabled = !data.more;
  $('direction').textContent = asc ? '↑ Ascending' : '↓ Descending';
  if (activeGroup) {
    if (rowIndex.has(activeGroup.id)) activeGroup = rowIndex.get(activeGroup.id);
    else if (queryChanged) activeGroup = null;
  }
  const sig = JSON.stringify(rows);
  if (sig !== rowSignature) {
    rowSignature = sig;
    paintRows();
    paintTree();
  }
  if (!selected && rows.length) {
    if (rows[0].entry_type === 'session') await activateSession(rows[0]);
    else await select(rows[0].id);
  }
  else if (queryChanged && listed(selected)) {
    if (!q && activeHits.length) hTab = 'Messages';
    await select(selected.id, false, !!q);
    if (!activeHits.length) inspect();
  }
  const row = rowIndex.get(selected?.id);
  if (row && row.entry_type !== 'session' && (row.status !== selected.status || row.ended !== selected.ended)) {
    const c = await loadEvent(row.id, row.entry_type);
    if (c.id === selected?.id) {
      selected = parseCall(c);
      hitRecord = '';
      await select(c.id, false, false);
    }
  }
}
function persistentState() {
  return {
    draft,
    open: [...openMessages],
    tab: dTab,
    field: field && {
      key: field.key,
      text: field.text,
      error: field.error,
      prettySource: field.projection?.original ?? null,
    },
    dirty,
    rTab,
  };
}
let statusTimer,
  lastSaveError = '';
function saveStatus(label, message = '') {
  clearTimeout(statusTimer);
  if (!message && (label === 'Saved' || !label) && $('notice').textContent === lastSaveError) {
    $('notice').textContent = '';
    lastSaveError = '';
  }
  const indicator = $('saveStatus');
  indicator.hidden = !label;
  indicator.textContent = label;
  if (label === 'Saved')
    statusTimer = setTimeout(() => {
      indicator.hidden = true;
    }, 1000);
  indicator.title = message || label;
  indicator.disabled = label !== 'Save failed';
  if (message) {
    lastSaveError = message;
    explain(Error(message));
  }
}
function paintTabStrip(tabs) {
  const strip = $('draftList'),
    closed = $('closedList');
  strip.replaceChildren();
  closed.replaceChildren();
  for (const tab of tabs.filter((t) => t.closed === null)) {
    const group = el('span', '', 'draftChip');
    const pick = button(
      tab.name,
      invoke(() => tabAction('select', { id: tab.id })),
    );
    pick.setAttribute('role', 'tab');
    pick.setAttribute('aria-selected', String(source?.id === tab.id));
    pick.title = tab.name;
    const close = button(
      '×',
      invoke(() => tabAction('close', { id: tab.id })),
      'closeTab',
    );
    close.setAttribute('aria-label', 'Close ' + tab.name);
    group.append(pick, close);
    strip.append(group);
  }
  for (const tab of tabs.filter((t) => t.closed !== null).sort((a, b) => b.closed - a.closed)) {
    const row = el('div', '', 'closedTab');
    const reopen = button(
      tab.name,
      invoke(() => tabAction('select', { id: tab.id })),
    );
    const remove = toolButton(
      icon('trash'),
      'Delete ' + tab.name,
      invoke(() => deleteTab(tab)),
    );
    row.append(reopen, remove);
    closed.append(row);
  }
  if (!closed.childElementCount) closed.append(el('small', 'No closed tabs'));
  for (const id of ['copyTab', 'renameTab', 'deleteTab']) $(id).disabled = !source;
}
async function installWorkspace(data, view) {
  writer?.dispose();
  writer = null;
  if (source) tabUndo.set(source.id, { undoStack, redoStack });
  source = data.tab;
  snapshot = null;
  runs = [];
  saved = [];
  ++runEpoch;
  delete $('runSelect').dataset.signature;
  $('runSelect').replaceChildren();
  $('runView').replaceChildren();
  if (source) {
    const state = source.state;
    delete source.state;
    const memory = tabUndo.get(source.id);
    undoStack = memory?.undoStack || [];
    redoStack = memory?.redoStack || [];
    cleanDraft = state.dirty ? null : state.draft;
    runId = source.selected_run;
    const legacyChanges = state.rTab === 'Changes';
    rTab = legacyChanges ? 'Answer' : state.rTab || 'Answer';
    const restoredField = state.field && {
      ...state.field,
      projection:
        typeof state.field.prettySource === 'string'
          ? prettyEditorText(state.field.prettySource)
          : null,
    };
    restoring = true;
    try {
      applyView({ ...state, tab: legacyChanges ? 'Changes' : state.tab, field: restoredField });
    } finally {
      restoring = false;
    }
    writer = draftWriter(
      { ...source, state },
      persistentState,
      (req, leaving) => api('tabs/save', req, leaving),
      saveStatus,
    );
    saveStatus('');
  } else {
    draft = cleanDraft = field = null;
    undoStack = [];
    redoStack = [];
    openMessages.clear();
    $('draftView').replaceChildren();
  }
  paintTabStrip(data.tabs);
  $('tabMenu').open = false;
  setWorkspace(view);
  if (source && view === 'repeater') await updateRuns(true);
  if (view === 'settings') paintMcp(await api('settings/mcp'));
}
async function tabAction(action, args = {}) {
  if (
    switching ||
    posting ||
    (action === 'select' && args.id === source?.id && workspace === 'repeater')
  )
    return;
  switching = true;
  $('repeat').inert = true;
  try {
    if (action === 'duplicate' && source) {
      // A local draft can still be rescued as a copy after a version conflict.
      try {
        await writer.flush();
      } catch {
        args.state = persistentState();
      }
    } else if (writer) await writer.flush();
    await viewWrite;
    const data = await api('tabs/' + action, args);
    await installWorkspace(data, 'repeater');
    if (action === 'delete') tabUndo.delete(args.id);
  } finally {
    $('repeat').inert = false;
    switching = false;
  }
}
async function fork() {
  if (selected)
    await tabAction('open', {
      ref: (selected.entry_type === 'repeater' ? 'run:' : 'trace:') + selected.id,
    });
}
async function deleteTab(tab) {
  $('tabMenu').open = false;
  if (
    await confirmAction(
      'Permanently delete the draft “' + tab.name + '”? Its sent runs stay in Trace.',
      'Delete draft',
      true,
    )
  )
    await tabAction('delete', { id: tab.id, confirmed: true });
}
$('copyTab').onclick = invoke(() => tabAction('duplicate', { id: source.id }));
$('deleteTab').onclick = invoke(() => deleteTab(source));
$('renameTab').onclick = () => {
  $('tabMenu').open = false;
  $('tabName').value = source.name;
  $('nameDialog').showModal();
  $('tabName').select();
};
$('cancelName').onclick = () => $('nameDialog').close();
$('applyName').onclick = invoke(async () => {
  const name = $('tabName').value.trim();
  if (!name) return $('tabName').focus();
  await tabAction('rename', { id: source.id, name });
  $('nameDialog').close();
});
$('tabName').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.isComposing) $('applyName').click();
};
$('saveStatus').onclick = invoke(() => writer?.flush());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) writer?.flush().catch(() => {});
});
window.addEventListener('beforeunload', (e) => {
  if (writer?.needsUnloadWarning()) {
    writer.flush().catch(() => {});
    e.preventDefault();
    e.returnValue = '';
  }
});
window.addEventListener('pagehide', () => writer?.leaving()?.catch(() => {}));

function bodyCheck(v) {
  if (source.protocol === 'responses') {
    if (!validRequest('responses', v))
      throw Error('Expected Responses input or a conversation reference.');
    return;
  }
  if (
    !v ||
    !Array.isArray(v.messages) ||
    v.messages.some((m) => !m || typeof m !== 'object' || Array.isArray(m))
  )
    throw Error('messages must be an array of message objects.');
}
function messageGap(index, empty = false) {
  const row = el('div', '', 'messageGap');
  const b = button('', () => insertMessage(index), 'insertGap' + (empty ? ' emptyGap' : ''));
  b.title = 'Insert message ' + (index + 1);
  b.setAttribute('aria-label', b.title);
  b.append(el('span', '+'));
  row.append(b);
  return row;
}
function toolButton(symbol, label, fn) {
  const b = button('', fn, 'editTool');
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(typeof symbol === 'string' ? el('span', symbol) : symbol);
  return b;
}
function focusField() {
  $('draftView').querySelector('.inlineSource')?.focus();
}
function openField(key, value, projection = null) {
  if (field?.error) return focusField();
  field = { key, text: projection?.text ?? value, error: '', projection };
  typing = false;
  renderDraft();
  focusField();
}
function closeField() {
  const discardedInput = !!field?.error;
  if (discardedInput) {
    undoStack.push(viewState());
    redoStack = [];
  }
  field = null;
  typing = false;
  renderDraft();
  if (discardedInput) markDraft();
}
function draftStatus() {
  const warning =
    field?.error ||
    (source.protocol === 'chat' ? pairingWarning(draft.messages) : '') ||
    (!validRequest(source.protocol, draft) ||
    (source.protocol !== 'responses' && !draft.messages.length)
      ? 'Add a valid request message.'
      : '');
  $('warning').textContent = warning;
  $('undo').disabled = !undoStack.length;
  $('redo').disabled = !redoStack.length;
  $('send').disabled = !!warning || posting;
  $('draftModel').textContent = draft.model || 'Select model';
  $('modelMenu').inert = !!field?.error;
}
function inlineSource(label, read) {
  const box = el('textarea', '', 'inlineSource');
  box.setAttribute('aria-label', label);
  box.setAttribute('aria-describedby', 'warning');
  box.spellcheck = false;
  box.value = field.text;
  box.rows = Math.max(2, Math.min(18, field.text.split('\n', 19).length));
  box.setAttribute('aria-invalid', String(!!field.error));
  box.onblur = () => {
    typing = false;
  };
  box.oninput = () => {
    if (field.text === box.value) return;
    if (!typing) {
      undoStack.push(viewState());
      typing = true;
    }
    redoStack = [];
    field.text = box.value;
    try {
      const next = read(box.value);
      bodyCheck(next);
      draft = next;
      field.error = '';
    } catch (e) {
      field.error = label + ' · ' + e.message;
    }
    dirty = true;
    const card = box.closest('.messageCard');
    if (card && !field.error) {
      card.querySelector(':scope > summary .snippet').textContent = messagePreview(
        draftEntries()[Number(card.dataset.index)]?.message,
        toolLookup(draftEntries().map(e => e.message)),
      );
    }
    box.setAttribute('aria-invalid', String(!!field.error));
    draftStatus();
    markDraft();
  };
  return box;
}
function replaceMessage(index, message) {
  const e = draftEntries()[index];
  if (e.message === e.value) return writeEntry(draft, e, message);
  if (e.index === null || typeof e.value === 'string')
    return writeEntry(draft, e, message.content ?? '');
  return writeEntry(draft, e, message.content[0]);
}
function editedPart(index, i, part) {
  const m = draftEntries()[index].message;
  const content = Array.isArray(m.content) ? m.content.slice() : part;
  if (Array.isArray(m.content)) content[i] = part;
  return replaceMessage(index, { ...m, content });
}
function insertMessage(index) {
  const entries = draftEntries(),
    key = source.protocol === 'responses' ? 'input' : 'messages';
  const at = entries.slice(0, index).filter((e) => e.key === key).length;
  commit(insertEntry(draft, source.protocol, at), index, 'Messages', {
    key: index + '/0',
    text: '',
    error: '',
  });
  focusField();
}
function editOnClick(view, label, start) {
  view.classList.add('editablePreview');
  view.tabIndex = 0;
  view.title = label;
  view.setAttribute('aria-label', label);
  view.onclick = (event) => {
    if (!event.target.closest('summary') && !window.getSelection()?.toString()) start();
  };
  view.onkeydown = (event) => {
    if (event.target === view && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      start();
    }
  };
}
const editActions = {
  toggled(index, isOpen) {
    if (openMessages.has(index) === isOpen) return;
    if (isOpen) openMessages.add(index);
    else {
      openMessages.delete(index);
      if (field?.key.startsWith(index + '/') && !field.error) closeField();
    }
  },
  messageBar(m, index) {
    const bar = el('span', '', 'msgActions'),
      role = el('select');
    role.setAttribute('aria-label', 'Message ' + (index + 1) + ' role');
    const entry = draftEntries()[index];
    const roles =
      source.protocol === 'anthropic'
        ? ['user', 'assistant']
        : source.protocol === 'responses'
          ? ['system', 'developer', 'user', 'assistant']
          : ['system', 'developer', 'user', 'assistant', 'tool', 'function'];
    for (const r of new Set([m.role, ...roles])) role.add(new Option(r, r));
    role.value = m.role;
    role.onchange = () => {
      if (field?.error) {
        role.value = draftEntries()[index].message.role;
        return focusField();
      }
      updateMessage(index, (copy) => {
        copy.role = role.value;
      });
    };
    const key = index + '/message';
    bar.append(
      entry.value === entry.message ? role : roleBadge(m.role),
      toolButton('{}', 'Message JSON', () => {
        if (field?.key === key) closeField();
        else openField(key, pretty(draftEntries()[index].value));
      }),
      toolButton(icon('trash'), 'Delete message', () => deleteMessage(index)),
    );
    return bar;
  },
  messageSource(body, index) {
    if (field?.key !== index + '/message') return false;
    body.append(
      inlineSource('Message JSON', (text) => {
        const v = JSON.parse(text);
        const entry = draftEntries()[index];
        const next = writeEntry(draft, entry, v);
        bodyCheck(next);
        if (entry.key === 'instructions' && typeof v !== 'string')
          throw Error('Instructions must be text.');
        if (entry.key === 'system' && !(typeof v === 'string' || Array.isArray(v)))
          throw Error('Expected system text or blocks.');
        return next;
      }),
    );
    return true;
  },
  part(index, i, part, label) {
    const key = index + '/' + i;
    const array = Array.isArray(draftEntries()[index].message.content);
    const isText = isTextBlock(part);
    const controls = [];
    if (array && draftEntries()[index].message.content.length > 1) {
      for (const [step, symbol, name] of [
        [-1, '↑', 'Move block up'],
        [1, '↓', 'Move block down'],
      ]) {
        const b = toolButton(symbol, name, () =>
          updateMessage(index, (copy) =>
            copy.content.splice(i + step, 0, copy.content.splice(i, 1)[0]),
          ),
        );
        b.disabled = i + step < 0 || i + step >= draftEntries()[index].message.content.length;
        controls.push(b);
      }
    }
    const currentPart = () =>
      array ? draftEntries()[index].message.content[i] : draftEntries()[index].message.content;
    const source = () => {
      if (field?.key === key + '/json') closeField();
      else openField(key + '/json', pretty(currentPart()));
    };
    controls.push(
      toolButton('{}', 'Block JSON', source),
      toolButton(icon('trash'), 'Delete block', () => {
        const entry = draftEntries()[index];
        if (entry.message !== entry.value && (entry.index !== null || !Array.isArray(entry.value)))
          return deleteMessage(index);
        return updateMessage(index, (copy) => {
          if (array) copy.content.splice(i, 1);
          else copy.content = null;
        });
      }),
    );
    if (field?.key === key || field?.key === key + '/json') {
      const json = field.key.endsWith('/json');
      const section = el('section', '', 'contentText');
      const editor = inlineSource(json ? 'Block JSON' : 'Edit text', (text) => {
        const prev = currentPart();
        if (field.projection) text = field.projection.encode(text);
        const next = json ? JSON.parse(text) : typeof prev === 'string' ? text : { ...prev, text };
        if (
          json &&
          (next == null ||
            (typeof next !== 'object' && typeof next !== 'string') ||
            Array.isArray(next))
        )
          throw Error('A content block must be text or a JSON object.');
        return editedPart(index, i, next);
      });
      section.append(
        sectionTitle(label, [
          toolButton(icon('pretty'), 'Back to preview', closeField),
          ...controls,
        ]),
        field.projection ? highlightedEditor(editor) : editor,
      );
      return section;
    }
    if (!isText) {
      const section = el('section', '', 'contentText'),
        view = blockData(part, toolLookup(draftEntries().map((e) => e.message)));
      editOnClick(view, 'Edit block JSON', source);
      section.append(sectionTitle(label, controls), view);
      return section;
    }
    const text = typeof part === 'string' ? part : part.text;
    const section = textBlock(label, text, controls);
    editOnClick(section.querySelector('.contentView'), 'Click to edit text', () =>
      openField(key, text, section.dataset.mode === 'pretty' ? prettyEditorText(text) : null),
    );
    if (typeof part === 'object') {
      const extra = Object.fromEntries(
        Object.entries(part).filter(([k]) => k !== 'type' && k !== 'text'),
      );
      if (Object.keys(extra).length) section.append(jsonTree(extra, 'Block attributes'));
    }
    return section;
  },
};
function renderDraft() {
  if (!draft) return;
  draftStatus();
  tabs('draftTabs', ['Messages', 'Full JSON', 'Changes'], dTab, (v) => {
    if (v === dTab) return;
    if (v === 'Changes' || dTab === 'Changes') {
      // Keep even incomplete editor text available while inspecting its diff.
      const editorTab = field?.key === 'request' ? 'Full JSON' : 'Messages';
      if (field?.error && v !== 'Changes' && v !== editorTab) {
        dTab = editorTab;
        renderDraft();
        return focusField();
      }
      if (v !== 'Changes' && v !== editorTab) field = null;
      dTab = v;
      renderDraft();
      return;
    }
    if (field?.error) return focusField();
    dTab = v;
    closeField();
  });
  const box = $('draftView'),
    scroll = box.scrollTop;
  box.replaceChildren();
  if (dTab === 'Changes') {
    const output = el('div');
    output.id = 'draftDiff';
    box.append(output);
    void refreshDraftDiff(output);
  } else if (dTab === 'Full JSON') {
    if (field?.key === 'request')
      box.append(
        inlineSource('Full request JSON', (text) => {
          const body = JSON.parse(text);
          bodyCheck(body);
          return body;
        }),
      );
    else box.append(jsonPanel(draft, () => openField('request', pretty(draft))));
  } else {
    const entries = draftEntries();
    const lookup = toolLookup(entries.map((e) => e.message));
    entries.forEach(({ message: m, key }, i) => {
      const c = messageCard(m, i, openMessages.has(i), editActions, lookup);
      c.dataset.index = i;
      if (key === 'messages' || key === 'input') box.append(messageGap(i));
      box.append(c);
    });
    const end = entries.length;
    box.append(messageGap(end, !end));
  }
  box.scrollTop = scroll;
}
function responseContent(reply, protocol = 'chat', includeEnvelope = false) {
  const native = responseMessages(protocol, reply);
  const emptyOutput = protocol === 'responses' && native?.length === 0;
  if (!emptyOutput && !native?.length && (!Array.isArray(reply?.choices) || !reply.choices.length))
    return jsonPanel(reply);
  const messages =
    native ||
    reply.choices.map((choice) => {
      if (choice?.message && typeof choice.message === 'object' && !Array.isArray(choice.message))
        return choice.message;
      if (typeof choice?.text === 'string') return { role: 'assistant', content: choice.text };
      return null;
    });
  if (messages.some((m) => !m)) return jsonPanel(reply);

  const panel = el('div');
  if (protocol === 'responses' && ['incomplete', 'failed'].includes(reply?.status)) {
    const state = reply.status === 'incomplete' ? 'Incomplete' : 'Failed';
    panel.append(el('p', [state, reply.incomplete_details?.reason, reply.error?.message || reply.error?.code]
      .filter(Boolean).join(' · '), 'responseOutcome ' + reply.status));
  }
  if (emptyOutput) {
    const tokens = reply.usage?.output_tokens;
    const detail = Number.isSafeInteger(tokens) ? ` Reported output tokens: ${tokens}.` : '';
    panel.append(el('p', 'The recorded response contains no output items.' + detail, 'hint'));

  }
  const lookup = toolLookup(messages);
  for (const [i, message] of messages.entries()) {
    const choice = reply.choices?.[i] || {};
    const block = message.content?.[0];
    const open = protocol !== 'responses' || (
      !['reasoning','compaction','compaction_trigger','additional_tools'].includes(block?.type) &&
      (phaseLabel(message) !== 'Progress' || messages.length === 1)
    );
    panel.append(
      messageCard(message, Number.isInteger(choice.index) ? choice.index : i, open, null, lookup),
    );
    if (choice.finish_reason && choice.finish_reason !== 'stop')
      panel.append(el('small', 'Finish reason · ' + choice.finish_reason));
  }
  if (includeEnvelope || emptyOutput) {
    const details = el('details', '', 'responseEnvelope');
    details.append(el('summary', 'Full response JSON'));
    details.ontoggle = () => {
      if (details.open && details.childElementCount === 1) details.append(jsonPanel(reply));
    };
    panel.append(details);
  }
  return panel;
}
function pendingRequestText() {
  if (field.key === 'request') return field.text;
  const [index, part] = field.key.split('/');
  const marker = crypto.randomUUID();
  const native =
    part === 'message'
      ? writeEntry(draft, draftEntries()[Number(index)], marker)
      : editedPart(Number(index), Number(part), marker);
  const text = pretty(native),
    offset = text.indexOf(JSON.stringify(marker));
  if (offset < 0) return pretty(draft);
  const indent = text.slice(text.lastIndexOf('\n', offset) + 1, offset).match(/^\s*/)[0];
  return text.replace(JSON.stringify(marker), () => field.text.replaceAll('\n', '\n' + indent));
}
async function refreshDraftDiff(output) {
  try {
    const result = await api('tabs/changes', {
      id: source.id,
      ...(field?.error ? { raw: pendingRequestText() } : { draft }),
    });
    if (output.isConnected) output.replaceChildren(changesView(result.hunks));
  } catch (error) {
    if (output.isConnected) output.replaceChildren(el('p', error.message, 'hint'));
  }
}
function failurePanel(failure) {
  const panel = el('section', '', 'runFailure');
  panel.append(el('strong', failure.http ? 'Gateway HTTP ' + failure.http : 'No HTTP response'));
  panel.append(el('p', failure.message));
  const facts = el('dl');
  for (const [name, value] of [
    ['Error code', failure.code], ['Error type', failure.type],
    ['Request ID', failure.requestId], ['Retry-After', failure.retryAfter],
  ]) {
    if (value) facts.append(el('dt', name), el('dd', value));
  }
  if (facts.childElementCount) panel.append(facts);
  if (failure.truncated) panel.append(el('small', 'Error body truncated at 8 KiB.'));
  return panel;
}
function paintRun() {
  tabs('runTabs', ['Answer', 'Response JSON', 'Request snapshot'], rTab, (v) => {
    rTab = v;
    paintRun();
  });
  const s = snapshot || {},
    reply = s.response,
    box = $('runView');
  box.replaceChildren();
  $('restore').disabled = !s.body || posting;
  $('runMeta').textContent = [
    runId === 'original' && (traceStatus(s) || 'Loading…'),
    s.ended != null ? s.ended - s.started + ' ms' : '',
    reply?.usage?.total_tokens != null ? reply.usage.total_tokens + ' tokens' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (rTab === 'Request snapshot' && s.body) box.append(jsonPanel(s.body));
  else if (s.status === 'failed' && s.failure) {
    if (rTab === 'Response JSON' && reply) box.append(jsonPanel(reply));
    else if (rTab === 'Response JSON' && s.failure.raw) {
      let raw;
      try { raw = JSON.parse(s.failure.raw); } catch {}
      box.append(raw === undefined ? el('pre', s.failure.raw) : jsonPanel(raw));
      if (s.failure.truncated) box.append(el('small', 'Error body truncated at 8 KiB.'));
    } else {
      box.append(failurePanel(s.failure));
      if (reply?.output?.length) box.append(responseContent(reply, source.protocol));
    }
  }
  else if (s.status === 'queued') box.append(queuedMessage(s.id, () => updateRuns(true)));
  else if (reply)
    box.append(
      rTab === 'Response JSON' ? jsonPanel(reply) : responseContent(reply, source.protocol),
    );
  else
    box.append(
      el(
        'p',
        s.error ||
          ({
            running: 'Waiting for the model…',
            draft: 'This draft has not been sent.',
            canceled: 'Canceled before sending.',
          }[s.status] || 'No complete response available.'),
        'hint',
      ),
    );
}
async function updateRuns(force = false) {
  if (!source) return;
  const id = source.id,
    epoch = ++runEpoch;
  const [kind, baseId] = source.source_ref.split(':');
  const d = await api('tabs/runs?id=' + id);
  if (epoch !== runEpoch || source?.id !== id) return;
  runs = d.runs;
  saved = d.drafts;
  const opts = [
    ['original', kind === 'run' ? 'Source replay' : 'Original capture'],
    ...runs
      .map((r) => [r.id, 'R' + r.seq + '  ' + time(r.started) + ' · ' + statusName[r.status]])
      .reverse(),
    ...saved.map((r) => [r.id, 'Draft · ' + time(r.created)]),
  ];
  const sig = JSON.stringify(opts);
  if ($('runSelect').dataset.signature !== sig) {
    $('runSelect').dataset.signature = sig;
    $('runSelect').replaceChildren(...opts.map(([v, t]) => new Option(t, v)));
  }
  $('runSelect').value = runId;
  const picked = runId,
    info = runs.find((r) => r.id === picked);
  if (
    force ||
    snapshot?.id !== (picked === 'original' ? baseId : picked) ||
    (info && info.status !== snapshot?.status) ||
    (picked === 'original' && ['pending', 'queued', 'running'].includes(snapshot?.status))
  ) {
    const s =
      picked === 'original'
        ? parseCall(await loadEvent(baseId, kind === 'run' ? 'repeater' : 'capture'))
        : parseCall(await api('snapshot/' + picked));
    if (epoch !== runEpoch || runId !== picked || source?.id !== id) return;
    snapshot = s;
    paintRun();
  }
  draftStatus();
}
async function send() {
  if (!source || posting || $('send').disabled || $('editDialog').open) return;
  posting = true;
  $('studio').inert = true;
  $('send').disabled = true;
  $('notice').textContent = '';
  const id = source.id,
    body = draft;
  typing = false;
  try {
    const revision = await writer.flush();
    const r = await api('tabs/send', { id, revision });
    if (source?.id === id) {
      runId = r.id;
      rTab = 'Answer';
      snapshot = null;
      const previouslyDirty = dirty;
      cleanDraft = body;
      dirty = draft !== body || !!field?.error;
      if (previouslyDirty !== dirty) markDraft();
    }
  } finally {
    posting = false;
    $('studio').inert = false;
    if (draft) {
      draftStatus();
      await updateRuns();
    }
  }
}
$('runSelect').onchange = invoke(async () => {
  const id = source.id,
    picked = $('runSelect').value;
  await api('tabs/pick', { id, run: picked });
  if (source?.id !== id) return;
  runId = picked;
  snapshot = null;
  paintRun();
  await updateRuns(true);
});
$('restore').onclick = invoke(async () => {
  const body = snapshot?.body;
  if (
    body &&
    (!dirty ||
      (await confirmAction(
        'Replace the current draft with the selected snapshot?',
        'Restore draft',
      )))
  ) {
    commit(body, requestEntries(source.protocol, body).length - 1, 'Messages');
  }
});
function bindSplitter(split, handle, initial, stacked) {
  const splitSizes = { width: initial, height: initial };
  function setSplit(percent) {
    const size = Math.max(25, Math.min(75, percent));
    splitSizes[stacked?.matches ? 'height' : 'width'] = size;
    split.style.setProperty('--first-share', size + 'fr');
    split.style.setProperty('--second-share', 100 - size + 'fr');
    handle.setAttribute('aria-orientation', stacked?.matches ? 'horizontal' : 'vertical');
    handle.setAttribute('aria-valuenow', String(Math.round(size)));
  }
  function syncSplit() {
    setSplit(splitSizes[stacked?.matches ? 'height' : 'width']);
  }
  stacked?.addEventListener('change', syncSplit);
  syncSplit();
  let dragOffset = 0;
  handle.onpointerdown = (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    const rect = handle.getBoundingClientRect();
    dragOffset = stacked?.matches ? e.clientY - rect.top : e.clientX - rect.left;
    handle.setPointerCapture(e.pointerId);
  };
  handle.onpointermove = (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    const rect = split.getBoundingClientRect();
    const extent = stacked?.matches
      ? rect.height - handle.offsetHeight
      : rect.width - handle.offsetWidth;
    const pos = stacked?.matches ? e.clientY - rect.top : e.clientX - rect.left;
    if (extent > 0) setSplit((100 * (pos - dragOffset)) / extent);
  };
  handle.ondblclick = () => setSplit(initial);
  handle.onkeydown = (e) => {
    const size = Number(handle.getAttribute('aria-valuenow'));
    const step = stacked?.matches ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    if (e.key === step[0]) setSplit(size - 5);
    else if (e.key === step[1]) setSplit(size + 5);
    else if (e.key === 'Home') setSplit(25);
    else if (e.key === 'End') setSplit(75);
    else return;
    e.preventDefault();
  };
}
bindSplitter($('trace'), $('traceHandle'), 30);
bindSplitter($('traceRight'), $('treeHandle'), 40);
bindSplitter($('repeatSplit'), $('splitHandle'), 50, window.matchMedia('(max-width: 760px)'));
$('filterButton').append(icon('sliders'));
$('undo').replaceChildren(icon('undo'));
$('redo').replaceChildren(icon('redo'));
$('pickTrace').onclick = () => $('toTrace').click();
for (const id of ['filterMenu', 'metaMenu', 'tabMenu']) {
  const menu = $(id);
  document.addEventListener('pointerdown', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
  menu.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  };
}
$('send').onclick = invoke(send);
$('fork').onclick = invoke(fork);
$('toTrace').onclick = invoke(async () => {
  setWorkspace('trace', true);
  await list();
});
$('toRepeat').onclick = invoke(async () => {
  setWorkspace('repeater', true);
  if (source) await updateRuns(true);
});
$('record').onclick = invoke(async () => {
  $('record').disabled = true;
  try {
    await api('recording', { enabled: !recording });
    await list();
  } finally {
    $('record').disabled = false;
  }
});
$('clearHistory').onclick = invoke(async () => {
  if (
    !(await confirmAction(
      'Permanently delete all captures, replay runs and drafts, including hidden records and all open and closed Repeater tabs? This cannot be undone.',
      'Clear all history',
      true,
    ))
  )
    return;
  const result = await api('history/clear', { confirmed: true });
  resetHistory(result.clearedThrough);
  $('notice').textContent = '';
  await list();
});
$('backList').onclick = () => $('trace').classList.remove('showDetail');
$('sortField').onchange = invoke(async () => {
  sort = $('sortField').value;
  offset = 0;
  await list();
});
$('direction').onclick = invoke(async () => {
  asc = !asc;
  offset = 0;
  await list();
});
let searchTimer;
const filters = filterBox($('filter'), $('filterChips'), $('filterSuggestions'), () => {
  clearTimeout(searchTimer);
  offset = 0;
  listEpoch++;
  searchTimer = setTimeout(invoke(list), 200);
});
$('statusFilter').onchange = $('typeFilter').onchange = invoke(async () => {
  offset = 0;
  await list();
});
$('prev').onclick = invoke(async () => {
  offset = Math.max(0, offset - 100);
  await list();
});
$('next').onclick = invoke(async () => {
  offset += 100;
  await list();
});
$('draftView').addEventListener(
  'click',
  (event) => {
    if (field?.error && !event.target.closest('.inlineSource')) {
      event.preventDefault();
      event.stopPropagation();
      focusField();
    }
  },
  true,
);
document.addEventListener(
  'keydown',
  invoke(async (e) => {
    if (
      $('nameDialog').open ||
      switching ||
      $('editDialog').open ||
      $('confirmDialog').open ||
      e.isComposing ||
      $('scopeMenu').open || $('modelMenu').open
    )
      return;
    if (workspace === 'repeater' && e.key === 'Escape' && field) {
      e.preventDefault();
      closeField();
      return;
    }
    if (
      workspace === 'repeater' &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      e.key.toLowerCase() === 'z' &&
      !e.target.closest('textarea:not(.inlineSource),input,[contenteditable=true]')
    ) {
      e.preventDefault();
      const inEditor = e.target.matches('.inlineSource');
      if (e.shiftKey) stepHistory(redoStack, undoStack);
      else stepHistory(undoStack, redoStack);
      if (inEditor) focusField();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && workspace === 'repeater') {
      e.preventDefault();
      await send();
      return;
    }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.key === '/' && workspace !== 'settings') {
      e.preventDefault();
      setWorkspace('trace', true);
      $('filter').focus();
      return;
    }
    const tr = e.target.closest('.eventRow');
    if (!tr) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (tr.classList.contains('sessionRow')) await activateSession(rowIndex.get(tr.dataset.id));
      else await select(tr.dataset.id, true);
    }
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      const all = [...tr.parentElement.querySelectorAll('.eventRow')];
      const next = all[all.indexOf(tr) + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        next.focus();
        if (next.classList.contains('sessionRow')) await activateSession(rowIndex.get(next.dataset.id));
        else await select(next.dataset.id);
      }
    }
  }),
);
async function poll() {
  try {
    if (workspace === 'trace' || !rows.length) await list();
    else paintRecording(await api('recording'));
    if (workspace === 'repeater' && source && !posting) await updateRuns();
  } catch (e) {
    explain(e);
  }
  setTimeout(poll, document.hidden ? 6000 : 2000);
}
async function initialize() {
  document.querySelector('body').inert = true;
  try {
    await prepareReload();
    await list();
    const data = await api('tabs/workspace');
    await installWorkspace(data, data.view);
  } catch (e) {
    explain(e);
  } finally {
    document.querySelector('body').inert = false;
    poll();
  }
}
initialize();
