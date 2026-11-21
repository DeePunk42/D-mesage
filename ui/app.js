import { continuePicker } from './continue-picker.js';
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
import { requestHistory } from './history-page.js';
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
  checking: 'Checking outcome…',
  checking_unknown: 'Checking outcome…',
  unconfirmed: 'Completion unconfirmed',
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
async function api(path, body, keepalive = false, signal) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(new URL('api/' + path, location.href), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + access,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: payload,
    keepalive: keepalive && new Blob([payload]).size < 60000,
    signal,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(Error(data.error || 'Request failed'), { dispatchState: data.dispatchState });
  return data;
}
let preferenceWrites = Promise.resolve();
function saveViewPreference(preference, path = 'view-preferences') {
  preferenceWrites = preferenceWrites
    .then(() => api(path, preference, true))
    .catch(explain);
}
let workspace = 'trace',
  selected = null,
  source = null,
  draft = null,
  dirty = false,
  posting = false;
let dTab = 'Messages',
  runView = { tab: 'Reply', raw: false },
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
const tabPositions = new Map();
let beforeChanges = 'Messages';
function rememberPosition() {
  if (!source || workspace !== 'repeater') return;
  const editor = $('draftView').querySelector('.inlineSource');
  tabPositions.set(source.id, {
    scroll: $('draftView').scrollTop,
    field: field?.key,
    caret: editor && [editor.selectionStart, editor.selectionEnd, editor.selectionDirection],
    editorScroll: editor?.scrollTop,
  });
}
function restorePosition() {
  const position = tabPositions.get(source?.id);
  if (position?.caret && position.field === field?.key) {
    const editor = $('draftView').querySelector('.inlineSource');
    if (editor) {
      editor.setSelectionRange(...position.caret);
      editor.scrollTop = position.editorScroll;
    }
  }
  $('draftView').scrollTop = position?.scroll ?? 0;
}
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
let repeaterLoaded = false;
function setWorkspace(tab, remember = false) {
  const changed = tab !== workspace;
  if (changed && workspace === 'repeater') rememberPosition();
  if (remember && tab !== workspace)
    viewWrite = viewWrite.then(() => api('tabs/view', { view: tab })).catch(explain);
  workspace = tab;
  for (const id of ['scopeMenu', 'filterMenu', 'metaMenu', 'tabMenu', 'modelMenu', 'runMenu', 'continueMenu']) $(id).open = false;
  $('settings').hidden = tab !== 'settings';
  $('toSettings').setAttribute('aria-pressed', tab === 'settings');
  $('mcpHint').textContent = '';
  $('mcpToken').hidden = true;
  $('mcpToken').value = '';
  $('mcpReveal').textContent = 'Show token';
  $('mcpReveal').setAttribute('aria-expanded', 'false');
  $('trace').hidden = tab !== 'trace';
  $('repeat').hidden = tab !== 'repeater';
  $('toTrace').setAttribute('aria-pressed', tab === 'trace');
  $('toRepeat').setAttribute('aria-pressed', tab === 'repeater');
  $('noDraft').hidden = !!draft;
  $('studio').hidden = !draft;
  if (changed) {
    if (tab === 'trace' && activeGroup) paintTree();
    else discardOlderPage();
  }
}
function dshFeedback(text) {
  $('dshFeedback').textContent = text;
  $('dshFeedback').hidden = !text;
}
function paintDsh(config) {
  const saved = !!config.origin;
  if ('overrideOrigin' in config) $('dshUrl').value = config.overrideOrigin;
  $('dshUrl').placeholder = config.detectedOrigin || config.origin || 'Auto-detect local desktop';
  $('dshStatus').dataset.state = config.connected ? 'on' : 'off';
  $('dshStatus').textContent = config.connected ? 'Connected' : saved ? 'Disconnected' : 'Not connected';
  $('dshCookie').placeholder = saved ? 'Saved credential · enter a replacement' : 'Launch URL, token, or cookie';
  $('dshConnect').textContent = saved ? 'Update' : 'Connect';
  $('dshDisconnect').hidden = !saved;
  dshFeedback(config.error || '');
}
$('dshHelpToggle').onclick = () => {
  const help = $('dshGrantHelp');
  help.hidden = !help.hidden;
  $('dshHelpToggle').setAttribute('aria-expanded', String(!help.hidden));
};
$('dshForm').onsubmit = invoke(async (event) => {
  event.preventDefault();
  $('dshConnect').disabled = true;
  $('dshDisconnect').disabled = true;
  try {
    paintDsh(await api('settings/dsh', { url: $('dshUrl').value.trim(), credential: $('dshCookie').value.trim() }));
    $('dshCookie').value = '';
    await refreshContinuations();
  } catch (error) {
    dshFeedback(error.message);
  } finally {
    $('dshConnect').disabled = $('dshDisconnect').disabled = false;
  }
});
$('dshDisconnect').onclick = invoke(async () => {
  paintDsh(await api('settings/dsh', { disconnect: true }));
  $('dshCookie').value = $('dshUrl').value = '';
  await refreshContinuations();
});
function paintReplayAgents(agents) {
  const container = $('nativeReplaySettings');
  for (const agent of agents) {
    let card = document.getElementById('replay-settings-' + agent.id);
    if (!card) {
      card = el('details', '', 'replayAgent nativeAgent');
      card.id = 'replay-settings-' + agent.id;
      const summary = el('summary', '', 'agentHeading');
      const status = el('small', '', 'connectionState');
      summary.append(agentIcon(agent.id), el('span', agentName(agent.id), 'agentTitle'), status);
      const form = el('form', '', 'agentFields');
      const path = el('input');
      path.id = 'replay-path-' + agent.id;
      path.spellcheck = false;
      const label = el('label', 'Executable path', 'agentLabel');
      label.htmlFor = path.id;
      const row = el('div', '', 'agentInputRow');
      const save = el('button', 'Save');
      save.type = 'submit';
      row.append(path, save);
      form.append(label, row);
      form.onsubmit = invoke(async event => {
        event.preventDefault();
        save.disabled = true;
        try {
          paintReplayAgents([await api('settings/replay', { id: agent.id, path: path.value.trim() })]);
          await refreshContinuations();
        } finally { save.disabled = false; }
      });
      card.append(summary, form);
      container.append(card);
    }
    const status = card.querySelector('small');
    status.dataset.state = agent.available ? 'on' : 'off';
    status.textContent = agent.available ? 'CLI available' : 'CLI unavailable';
    const input = card.querySelector('input');
    input.value = agent.path;
    input.placeholder = agent.detected || 'Auto-detect executable';
  }
}
async function loadSettings() {
  const [mcp, dsh, agents] = await Promise.all([api('settings/mcp'), api('settings/dsh'), api('settings/replay')]);
  paintMcp(mcp);
  paintDsh(dsh);
  paintReplayAgents(agents);
}
let savedListener;
function updateListenerAction() {
  $('mcpApply').hidden = !savedListener ||
    ($('mcpEnabled').checked === savedListener.enabled && $('mcpPort').value === String(savedListener.port));
}
$('mcpForm').oninput = updateListenerAction;
function paintMcp(config) {
  savedListener = config;
  $('mcpEnabled').checked = config.enabled;
  $('mcpPort').value = config.port;
  $('mcpUrl').value = config.url;
  $('mcpStatus').dataset.state = config.error ? 'error' : config.listening ? 'on' : 'off';
  $('mcpStatus').textContent =
    config.error || (config.listening ? 'Listening on 127.0.0.1' : 'Listener off');
  $('mcpCopy').disabled = !config.listening;
  updateListenerAction();
}
$('toSettings').onclick = invoke(async () => {
  setWorkspace('settings', true);
  await loadSettings();
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
    $('mcpReveal').setAttribute('aria-expanded', 'true');
  } else {
    input.value = '';
    input.hidden = true;
    $('mcpReveal').textContent = 'Show token';
    $('mcpReveal').setAttribute('aria-expanded', 'false');
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
function formatToggle(id, label, available, raw, toggle) {
  const control = $(id);
  control.hidden = !available;
  control.title = raw ? `Show parsed ${label}` : `Show raw ${label}`;
  control.setAttribute('aria-label', control.title);
  control.setAttribute('aria-pressed', String(raw));
  control.onclick = toggle;
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
const sessionViews = new Map();
const defaultTraceView = { tab: 'Request', requestRaw: false, replyRaw: false };
let traceView = defaultTraceView;
let followingHit = false;
let selectionController, inspectEpoch = 0;
const detailParts = new WeakMap();
function preferredTraceView(record) {
  if (!record.session) return defaultTraceView;
  const group = sessionRowId(record.agent, record.session);
  return sessionViews.get(group) ?? { ...defaultTraceView, ...record.detail_view };
}
function chooseTraceView(change) {
  const previous = traceView;
  traceView = { ...previous, ...change };
  followingHit = false;
  if (selected.session && Object.keys(change).some((key) => previous[key] !== change[key])) {
    sessionViews.set(sessionRowId(selected.agent, selected.session), traceView);
    saveViewPreference({ record: selected.id, ...traceView });
  }
  inspect(true);
}
function focusHit(index) {
  hitIndex = index;
  followingHit = true;
  inspect();
}
const detailFields = { request: 'body', reply: 'response', history: 'historyPage' };
async function loadHistoryPage(record, before) {
  if (Object.hasOwn(record, 'body')) {
    record.historySource ??= requestHistory(record.protocol, record.body);
    return record.historySource(before);
  }
  return loadEvent(record.id, record.entry_type, 'history', record.signal, before);
}
function loadDetailPart(record, part) {
  if (Object.hasOwn(record, detailFields[part])) return Promise.resolve();
  if (!detailParts.has(record)) detailParts.set(record, {});
  const pending = detailParts.get(record);
  if (part === 'history')
    return (pending.history ??= loadHistoryPage(record).then((page) => {
      record.historyPage = page;
    }).finally(() => delete pending.history));
  return (pending[part] ??= loadEvent(record.id, record.entry_type, part, record.signal).then((data) => {
    if (part === 'request') record.body = JSON.parse(data.request);
    else {
      record.response = JSON.parse(data.reply);
      record.error = data.error;
      record.failure = data.failure;
      record.recovered_output = data.recovered_output;
    }
  }).finally(() => delete pending[part]));
}
function prefetchDetails(record, part) {
  if (record.prefetching) return;
  record.prefetching = true;
  // Yield a paint before reading and parsing the other payload.
  requestAnimationFrame(() => setTimeout(async () => {
    if (record !== selected || record.signal.aborted || workspace !== 'trace') {
      record.prefetching = false;
      return;
    }
    try {
      await Promise.all(['request', 'reply'].filter((side) => side !== part)
        .map((side) => loadDetailPart(record, side)));
    } catch {
      // Opening that tab can retry a failed speculative request.
      record.prefetching = false;
      return;
    }
    if (record !== selected || record.signal.aborted || !record.searchHit) return;
    const focused = activeHits[hitIndex];
    const hits = searchConditions(hitQuery).flatMap((query) =>
      [...rankedHits(record.body, record.response, query, record.searchHit.kept)]);
    const index = focused && hits.findIndex((hit) =>
      hit.side === focused.side && hit.term === focused.term &&
      pointer(hit.path) === pointer(focused.path) && hit.start === focused.start);
    if (hits.length) {
      activeHits = hits;
      hitIndex = Math.max(0, index || 0);
      if (followingHit) updateHitBar(activeHits[hitIndex]);
    }
  }, 0));
}
function updateHitBar(hit) {
  $('hitBar').hidden = !hit;
  if (!hit) return;
  $('hitPath').textContent = hit.side + ' ' + pointer(hit.path);
  $('hitCount').textContent = hitIndex + 1 + ' / ' + activeHits.length;
  $('hitPrev').disabled = hitIndex === 0;
  $('hitNext').disabled = hitIndex === activeHits.length - 1;
}
$('hitPrev').onclick = () => focusHit(hitIndex - 1);
$('hitNext').onclick = () => focusHit(hitIndex + 1);
function inspect(scroll = false) {
  if (!selected) return;
  const record = selected;
  const epoch = ++inspectEpoch;
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
  const hit = followingHit ? activeHits[hitIndex] : null;
  const tab = hit ? (hit.side === 'request' ? 'Request' : 'Reply') : traceView.tab;
  const part = tab.toLowerCase();
  const request = tab === 'Request';
  const mode = request ? 'requestRaw' : 'replyRaw';
  const raw = !!hit || traceView[mode];
  tabs('histTabs', ['Request', 'Reply', 'History'], tab, (tab) => chooseTraceView({ tab }));
  formatToggle(
    'traceFormat',
    request ? 'request' : 'reply',
    request || (tab === 'Reply' && hasRawReply(selected)),
    raw,
    () => chooseTraceView({ tab, [mode]: !raw }),
  );
  const box = $('inspectView');
  detachHistory(box);
  box.replaceChildren();
  if (scroll) box.scrollTop = 0;
  updateHitBar(hit);
  if (!Object.hasOwn(record, detailFields[part])) {
    box.append(el('p', `Loading ${tab.toLowerCase()}…`, 'hint'));
    void loadDetailPart(record, part).then(() => {
      if (record === selected && epoch === inspectEpoch && !record.signal.aborted) inspect(scroll);
    }).catch((error) => {
      if (record === selected && epoch === inspectEpoch && !record.signal.aborted) {
        box.replaceChildren(el('p', error.message, 'hint'));
      }
    });
    return;
  }
  if (request && raw) box.append(jsonPanel(selected.body, null, hit));
  else if (request && selected.session) {
    if (!renderTurn(box)) return;
  }
  else if (tab === 'Reply') box.append(replyContent(selected, raw, list, hit));
  else if (tab === 'History') renderHistory(box, record);
  else renderRequestMessages(box);
  if (hit)
    requestAnimationFrame(() =>
      box.querySelector('.searchTarget mark')?.scrollIntoView({ block: 'nearest' }),
    );
  prefetchDetails(record, part);
}
function renderRequestMessages(box) {
  const messages = requestEntries(selected.protocol, selected.body).map((entry) => entry.message);
  const lookup = toolLookup(messages);
  messages.forEach((message, i) =>
    box.append(messageCard(message, i, i === messages.length - 1, null, lookup)),
  );
}
let visibleHistory;
const historyObserver = new IntersectionObserver((entries) => {
  const view = visibleHistory;
  const entry = entries.findLast(({ target }) => target === view?.edge);
  if (!entry) return;
  view.near = entry.isIntersecting;
  revealHistoryPage(view);
}, { root: $('inspectView'), rootMargin: '320px 0px 0px' });

function detachHistory(box) {
  if (!visibleHistory) return;
  visibleHistory.scroll = box.scrollTop;
  historyObserver.disconnect();
  visibleHistory = null;
}
function historyCards(page, openLast = false) {
  const lookup = toolLookup(page.messages);
  for (const [id, call] of page.linked) lookup.set(id, call);
  const cards = document.createDocumentFragment();
  page.messages.forEach((message, i) => {
    cards.append(messageCard(message, page.start + i, openLast && i === page.messages.length - 1, null, lookup));
  });
  return cards;
}
function watchHistoryEdge(view) {
  historyObserver.disconnect();
  view.near = false;
  if (view.next == null) view.edge.remove();
  else {
    historyObserver.observe(view.edge);
    requestAnimationFrame(() => setTimeout(() => prefetchHistoryPage(view), 0));
  }
}
function renderHistory(box, record) {
  if (!record.historyView) {
    const list = el('div');
    const edge = el('div', '', 'treeEdge');
    edge.setAttribute('role', 'status');
    list.append(edge, historyCards(record.historyPage, true));
    record.historyView = { list, edge, next: record.historyPage.next };
  }
  const view = record.historyView;
  view.record = record;
  visibleHistory = view;
  box.append(view.list);
  box.scrollTop = view.scroll ?? box.scrollHeight;
  watchHistoryEdge(view);
}
async function prefetchHistoryPage(view) {
  if (visibleHistory !== view || workspace !== 'trace' || view.loading || view.staged ||
      view.next == null || view.record.signal.aborted) return;
  const record = view.record;
  view.loading = true;
  view.error = false;
  revealHistoryPage(view);
  try {
    view.staged = await loadHistoryPage(record, view.next);
  } catch {
    view.error = !record.signal.aborted;
  } finally {
    view.loading = false;
  }
  if (record.signal.aborted && view.record !== record) await prefetchHistoryPage(view);
  else revealHistoryPage(view);
}
function revealHistoryPage(view) {
  if (visibleHistory !== view || workspace !== 'trace' || !view.near || view.record.signal.aborted) return;
  if (view.error) {
    view.edge.replaceChildren(button('Retry loading earlier messages', () => prefetchHistoryPage(view)));
    return;
  }
  if (!view.staged) {
    view.edge.textContent = 'Loading…';
    return;
  }
  const box = $('inspectView');
  const anchor = view.edge.nextElementSibling;
  const top = anchor?.getBoundingClientRect().top;
  view.edge.textContent = '';
  view.edge.after(historyCards(view.staged));
  view.next = view.staged.next;
  view.staged = null;
  if (anchor) box.scrollTop += anchor.getBoundingClientRect().top - top;
  watchHistoryEdge(view);
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
function noReply(record, refresh) {
  if (record.status === 'queued') return queuedMessage(record.id, refresh);
  return el(
    'p',
    record.error ||
      {
        canceled: 'Canceled before sending.',
        pending: 'Waiting for a response…',
        checking: 'Checking the Magpie request ledger…',
        checking_unknown: 'Checking the Magpie request ledger…',
        complete: 'Response not captured.',
        running: 'Waiting for a response…',
        draft: 'This draft has not been sent.',
        incomplete:
          record.entry_type === 'capture' && record.ended == null
            ? 'The capture ended without a completion callback. The model outcome is unknown.'
            : 'No complete response was captured.',
        failed: 'The request failed before a response was saved.',
      }[record.status] ||
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
    ref = nodeRef(p) || (n.parentSeq == null ? '' : '#' + n.parentSeq);
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
function fetchTreePage(agent, session, active, before, signal) {
  const query = new URLSearchParams({ agent: agent ?? '', session, page: '1', active: active ? '1' : '0' });
  if (before) query.set('before', before);
  return api('sessions/tree?' + query, undefined, false, signal);
}
async function ensureTree(id, agent, session, sig) {
  const active = activeOnly;
  const cached = trees.get(id);
  const sameView = cached?.active === active;
  if (sameView && (cached.loading || (cached.sig === sig && !cached.error))) return;
  const loading = { ...(sameView ? cached : {}), sig, active, loading: true, error: false };
  trees.set(id, loading);
  try {
    const data = await fetchTreePage(agent, session, active);
    if (trees.get(id) !== loading) return;
    const keepPages = sameView && data.nodes.some((node) => cached.byId?.has(node.id));
    const saved = keepPages ? cached.byId : null;
    const byId = new Map([...(saved ?? []), ...data.nodes.map((n) => [n.id, n])]);
    const paged = !!(keepPages && cached.paged);
    trees.set(id, {
      sig, active, nodes: [...byId.values()], byId, next: paged ? cached.next : data.next, paged,
    });
  } catch (error) {
    if (trees.get(id) === loading) {
      trees.set(id, { ...loading, loading: false, error: true });
      if (activeGroup?.id === id) paintTree();
    }
    throw error;
  }
  if (activeGroup?.id === id) paintTree();
  if (selected?.signal.aborted) return;
  const node = trees.get(id).byId.get(selected?.id);
  if (node && (node.status !== selected.status || node.ended !== selected.ended)) {
    await select(node.id, false, false, node, true);
  } else if (selected?.session && sessionRowId(selected.agent, selected.session) === id &&
      !followingHit && traceView.tab === 'Request' && !traceView.requestRaw) inspect();
}
let olderPage;
const treeEdgeObserver = new IntersectionObserver((entries) => {
  const entry = entries.findLast(({ target }) => target === olderPage?.edge);
  if (!entry) return;
  olderPage.near = entry.isIntersecting;
  revealOlderPage();
}, { root: $('treeRows'), rootMargin: '320px 0px' });

function discardOlderPage() {
  treeEdgeObserver.disconnect();
  olderPage?.controller.abort();
  olderPage = null;
}
async function prefetchOlderPage(page) {
  if (page !== olderPage) return;
  page.error = false;
  revealOlderPage();
  try {
    const { agent, session } = activeGroup;
    page.result = await fetchTreePage(agent, session, page.active, page.cursor, page.controller.signal);
  } catch {
    page.error = true;
  }
  if (page === olderPage) revealOlderPage();
}
function revealOlderPage() {
  const page = olderPage;
  if (!page?.near || workspace !== 'trace' || activeGroup?.id !== page.id) return;
  const tree = trees.get(page.id);
  if (tree?.loading || tree?.next !== page.cursor || tree.active !== page.active) return;
  if (page.error) {
    page.edge.replaceChildren(button('Retry loading older requests', () => prefetchOlderPage(page)));
    return;
  }
  if (!page.result) {
    page.edge.textContent = 'Loading…';
    return;
  }
  const { nodes, next } = page.result;
  discardOlderPage();
  for (const node of nodes) tree.byId.set(node.id, node);
  tree.nodes = [...tree.byId.values()];
  tree.next = next === page.cursor ? null : next;
  tree.paged = true;
  paintTree();
}
function watchTreeEdge(group, tree, edge) {
  if (workspace !== 'trace' || !edge) return discardOlderPage();
  if (olderPage?.id !== group.id || olderPage.cursor !== tree.next || olderPage.active !== tree.active) {
    discardOlderPage();
    const page = { id: group.id, cursor: tree.next, active: tree.active, controller: new AbortController() };
    olderPage = page;
    requestAnimationFrame(() => setTimeout(() => prefetchOlderPage(page), 0));
  }
  olderPage.edge = edge;
  olderPage.near = false;
  treeEdgeObserver.observe(edge);
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
const traceStatusIcons = {
  pending: 'spinner', running: 'spinner', checking: 'spinner', checking_unknown: 'spinner',
  queued: 'clock', failed: 'cross', interrupted: 'cross', canceled: 'cross', incomplete: 'cross',
  unconfirmed: 'unknown',
};
function previewLine(r, hit) {
  const line = el('span', '', 'eventPreview');
  if (hit) {
    line.append(el('small', hit.side), el('span', hit.preview, 'snippet'));
    line.title = pointer(hit.path);
  } else {
    line.append(roleBadge(r.last_role));
    if (r.last_role === 'tool') line.append(icon('wrench'));
    line.append(el('span', r.last_preview || '—', 'snippet'));
    if (r.final_preview) line.append(el('span', r.final_preview, 'snippet'));
    line.title = [r.last_preview, r.final_preview].filter(Boolean).join(' · ');
  }
  const finalAnswer = r.status === 'complete' && r.final_preview != null;
  if (finalAnswer || (r.status && r.status !== 'complete')) {
    const label = finalAnswer ? 'Final answer' : traceStatus(r);
    const name = finalAnswer ? 'check' : label === statusName.unconfirmed ? 'unknown' : traceStatusIcons[r.status];
    const badge = el('small', name ? '' : label, 'eventStatus');
    badge.title = label;
    if (name) {
      badge.classList.add('status-' + name);
      badge.setAttribute('role', 'img');
      badge.setAttribute('aria-label', label);
      badge.append(icon(name));
    }
    line.append(badge);
  }
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
  if (activeGroup?.id === g.id) $('trace').classList.add('showDetail');
}
function sessionRow(g) {
  const row = el('button', '', 'eventRow sessionRow');
  row.dataset.id = g.id;
  row.setAttribute('aria-current', String(activeGroup?.id === g.id));
  const top = el('span', '', 'eventTop');
  const title = el('b', g.title || 'Session');
  title.title = g.title || '';
  top.append(
    el('span', '', 'sessionMark'),
    title,
    el('small', agentName(g.agent), 'sessionAgent'),
    el('time', time(g.last)),
  );
  row.title = sessionCounts(g) + '\nSession ' + g.session;
  row.append(top, previewLine(g.latest, g.latest.hit));
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
  treeEdgeObserver.disconnect();
  const g = activeGroup;
  $('traceRight').classList.toggle('noTree', !g);
  syncTraceSplit();
  const box = $('treeRows');
  if (!g) {
    discardOlderPage();
    return box.replaceChildren();
  }
  $('treeTitle').textContent = g.title || 'Session';
  $('treeTitle').title = g.title || '';
  $('treeMeta').textContent = sessionCounts(g);
  $('mainOnly').checked = activeOnly;
  let tree = trees.get(g.id);
  const sig = treeSignature(g);
  if (workspace === 'trace' && (tree?.sig !== sig || tree.active !== activeOnly)) {
    void ensureTree(g.id, g.agent, g.session, sig).catch(explain);
    tree = trees.get(g.id);
  }
  if (!tree?.nodes) {
    discardOlderPage();
    const content = tree?.error
      ? button('Retry loading session', invoke(() => ensureTree(g.id, g.agent, g.session, sig)), 'olderRequests')
      : el('p', 'Loading session…', 'hint treeHint');
    return box.replaceChildren(content);
  }
  const focus = box.contains(document.activeElement),
    scroll = box.scrollTop;
  let nodes = tree.nodes
    .slice()
    .sort((a, b) => b.started - a.started || (a.entry_type === b.entry_type ? b.seq - a.seq : a.entry_type === 'repeater' ? -1 : 1));
  const active = activeBranch(nodes);
  const layout = laneLayout(nodes, active);
  const flipped = sort === 'time' && asc;
  const order = nodes.map((n, i) => [n, layout.rows[i]]);
  if (flipped) order.reverse();
  const rendered = order.map(([n, lane]) => treeRow(g, n, lane, layout.width, flipped, tree.byId));
  const edge = tree.next ? el('div', '', 'treeEdge') : null;
  if (edge) {
    edge.setAttribute('role', 'status');
    if (flipped) rendered.unshift(edge);
    else rendered.push(edge);
  }
  const anchor = flipped ? box.scrollHeight - scroll : scroll;
  box.replaceChildren(...rendered);
  box.scrollTop = flipped ? box.scrollHeight - anchor : scroll;
  if (focus) box.querySelector('[aria-current=true]')?.focus({ preventScroll: true });
  watchTreeEdge(g, tree, edge);
}
$('mainOnly').onchange = () => {
  activeOnly = $('mainOnly').checked;
  paintTree();
};
function renderTurn(box) {
  const id = sessionRowId(selected.agent, selected.session);
  const tree = trees.get(id),
    node = tree?.byId?.get(selected.id) ?? selected.turn;
  if (!node) {
    if (selected.turn === null) {
      renderRequestMessages(box);
      return true;
    }
    box.append(el('p', 'Loading session…', 'hint'));
    if (!tree?.loading && !selected.turnLoading) {
      const record = selected;
      const query = new URLSearchParams({ agent: record.agent ?? '', session: record.session, focus: record.id });
      record.turnLoading = true;
      void api('sessions/tree?' + query, undefined, false, record.signal).then(({ node }) => {
        record.turn = node;
        if (record === selected && !record.signal.aborted) inspect();
      }).catch((error) => {
        record.turnLoading = false;
        if (record === selected && !record.signal.aborted) explain(error);
      });
    }
    return false;
  }
  const head = el('div', '', 'turnHead');
  head.append(el('span', describeNode(node, tree?.byId ?? new Map())));
  if (node.parent) head.append(button('Go to #' + node.parentSeq, invoke(() =>
    select(node.parent, false, true, { id: node.parent, entry_type: 'capture' }))));
  box.append(head);
  if (!node.parent || node.entry_type === 'repeater') {
    renderRequestMessages(box);
    return true;
  }
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
  return true;
}
function loadEvent(id, entryType, part, signal, before) {
  const path = (entryType === 'repeater' ? 'snapshot/' : 'calls/') + id;
  const query = new URLSearchParams();
  if (part) query.set('part', part);
  if (before !== undefined) query.set('before', String(before));
  return api(path + (query.size ? '?' + query : ''), undefined, false, signal);
}
async function select(id, open = false, jump = true, suppliedRow, reload = false) {
  const epoch = ++detailEpoch;
  const row = rowIndex.get(id) ?? treeEntry(id) ?? suppliedRow ?? (selected?.id === id ? selected : null);
  if (!row || row.entry_type === 'session') return;
  const changed = selected?.id !== id;
  if (changed || reload || selected.signal.aborted) {
    selectionController?.abort();
    selectionController = new AbortController();
    const { signal } = selectionController;
    const previous = selected;
    let meta;
    try {
      meta = await loadEvent(id, row.entry_type, 'meta', signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      return;
    }
    if (epoch !== detailEpoch) return;
    selected = { ...meta, signal };
    if (changed) {
      traceView = preferredTraceView(selected);
      followingHit = false;
    } else {
      for (const field of ['body', 'historyPage', 'historyView'])
        if (Object.hasOwn(previous, field)) selected[field] = previous[field];
    }
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
    selected.searchHit = row.hit;
    selected.prefetching = false;
    activeHits = row.hit ? [row.hit] : [];
    hitIndex = 0;
    if (!activeHits.length) followingHit = false;
  }
  if (jump && activeHits.length) focusHit(hitIndex);
  else if (changed || reload || !jump) inspect(true);
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
  selectionController?.abort();
  detachHistory($('inspectView'));
  selected = source = draft = cleanDraft = snapshot = field = null;
  viewContinuation(null);
  dirty = typing = false;
  rows = [];
  rowIndex.clear();
  runs = [];
  saved = [];
  undoStack = [];
  redoStack = [];
  writer?.dispose();
  writer = null;
  tabUndo.clear();
  tabPositions.clear();
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
  sessionViews.clear();
  followingHit = false;
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

const { view: viewContinuation, refresh: refreshContinuations } = continuePicker({
  root: $('continueControls'), menu: $('continueMenu'), choices: $('continueChoices'),
  launch: $('continueAgent'), message: $('continueMessage'), api, agentIcon, agentName,
  savedRevision: () => writer.flush(),
  currentRequest: () => {
    if (field?.error) throw Error(field.error);
    if (!draft) throw Error('No request draft is open.');
    return draft;
  },
});
function paintScope(agents) {
  const summary = $('scopeSummary');
  const label =
    agents === 'all' ? allAgentsName : agents.map(agentName).join(', ') || 'No agents selected';
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
    options = el('div', '', 'scopeOptions'),
    candidates = new Set(choices),
    picks = new Set(selected === 'all' ? [] : selected),
    original = new Set([...candidates, ...picks]),
    added = new Set(),
    removed = new Set();
  group.append(el('legend', 'Agents'));
  function check(value, checked) {
    const row = el('div', '', 'scopeChoice'),
      label = el('label'),
      input = el('input'),
      name = value ? agentName(value) : allAgentsName;
    input.type = 'checkbox';
    input.checked = checked;
    label.append(agentIcon(value), el('span', name, 'scopeName'), input);
    row.append(label);
    return { row, input };
  }
  const { row: allRow, input: all } = check(null, selected === 'all');
  allRow.classList.add('scopeAll');
  allRow.title = 'Record all local agents, including agents hidden from this list.';
  group.append(allRow);
  function drawOptions() {
    const scroll = options.scrollTop;
    options.replaceChildren();
    [...new Set([...candidates, ...picks])].sort().forEach((name, index) => {
      const { row, input } = check(name, picks.has(name));
      input.onchange = () => {
        all.checked = false;
        if (input.checked) picks.add(name);
        else picks.delete(name);
      };
      const remove = toolButton(icon('trash'), 'Remove ' + agentName(name), () => {
        candidates.delete(name);
        picks.delete(name);
        added.delete(name);
        if (original.has(name)) removed.add(name);
        drawOptions();
        const next = options.children[Math.min(index, options.children.length - 1)];
        (next?.querySelector('input') ?? all).focus();
      });
      remove.classList.add('scopeRemove');
      row.append(remove);
      options.append(row);
    });
    options.scrollTop = scroll;
  }
  all.onchange = () => {
    if (all.checked) {
      picks.clear();
      drawOptions();
    }
  };
  drawOptions();
  const line = el('div', '', 'scopeManual'),
    input = el('input'),
    hint = el('p', '', 'scopeHint');
  hint.id = 'scopeAgentHint';
  hint.append('For API key ', el('code', 'magpie-xxx'), ', enter ', el('code', 'xxx'), '.');
  input.placeholder = 'Agent ID';
  input.setAttribute('aria-label', input.placeholder);
  input.setAttribute('aria-describedby', hint.id);
  function add() {
    const value = input.value.trim();
    if (!value) return;
    all.checked = false;
    picks.add(value);
    if (!candidates.has(value)) added.add(value);
    candidates.add(value);
    removed.delete(value);
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
  group.append(options, line, hint);
  $('scopeFields').append(group);
  return () => {
    add();
    return { agents: all.checked ? 'all' : [...picks].sort(), add: [...added], remove: [...removed] };
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
  const state = await api('capture-scope');
  if (epoch !== menuEpoch || !$('scopeMenu').open) return;
  paintRecording(state);
  const { scope, choices } = state;
  const changes = scopeOptions(choices.agents, scope.agents);
  $('scopeApply').disabled = false;
  $('scopeApply').onclick = async () => {
    $('scopeApply').disabled = true;
    try {
      const state = await api('capture-scope', changes());
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
    selectionController?.abort();
    selected = null;
    $('inspector').hidden = true;
    $('emptyInspect').hidden = false;
  }
  const queryChanged = query !== listQuery;
  listQuery = query;
  if (offset && !rows.length) {
    offset = Math.max(0, Math.floor((data.total - 1) / 100) * 100);
    return list();
  }
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
  const previousGroup = activeGroup;
  if (activeGroup) {
    if (rowIndex.has(activeGroup.id)) activeGroup = rowIndex.get(activeGroup.id);
    else if (queryChanged) activeGroup = null;
  }
  const sig = JSON.stringify(rows);
  if (sig !== rowSignature) {
    rowSignature = sig;
    paintRows();
  }
  if (queryChanged || JSON.stringify(activeGroup) !== JSON.stringify(previousGroup)) {
    paintTree();
  }
  if (queryChanged && listed(selected)) {
    if (!q) followingHit = false;
    await select(selected.id, false, !!q);
    if (!activeHits.length) inspect();
  }
  let row = rowIndex.get(selected?.id);
  if (!row && selected?.status.startsWith('checking')) {
    const record = selected;
    row = await loadEvent(record.id, record.entry_type, 'meta', record.signal);
    if (record !== selected || epoch !== listEpoch) return;
    const node = activeGroup && trees.get(activeGroup.id)?.byId?.get(record.id);
    if (node && node.status !== row.status) {
      Object.assign(node, { status: row.status, ended: row.ended });
      paintTree();
    }
  }
  if (row && !selected.signal.aborted && (row.status !== selected.status || row.ended !== selected.ended)) {
    await select(row.id, false, false, row, true);
  }
}
function persistentState() {
  return {
    draft,
    open: [...openMessages],
    tab: dTab,
    beforeChanges: dTab === 'Changes' ? beforeChanges : undefined,
    field: field && {
      key: field.key,
      text: field.text,
      error: field.error,
      prettySource: field.projection?.original ?? null,
    },
    dirty,
    rTab: source?.legacyRunTab,
  };
}
function saveStatus(label, message = '') {
  const indicator = $('saveStatus');
  indicator.hidden = label !== 'Save failed';
  indicator.textContent = message ? `${message} · Retry save` : 'Save failed · Retry';
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
  if (!source) $('undo').disabled = $('redo').disabled = true;
}
async function installWorkspace(data, view) {
  repeaterLoaded = true;
  rememberPosition();
  writer?.dispose();
  writer = null;
  if (source) tabUndo.set(source.id, { undoStack, redoStack });
  source = data.tab;
  viewContinuation(source);
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
    beforeChanges = (legacyChanges ? state.tab : state.beforeChanges) === 'Full JSON' ||
      state.field?.key === 'request' ? 'Full JSON' : 'Messages';
    if (!source.run_view && ['Response JSON', 'Request snapshot'].includes(state.rTab))
      source.legacyRunTab = state.rTab;
    runView = source.run_view ?? {
      tab: state.rTab === 'Request snapshot' ? 'Request snapshot' : 'Reply',
      raw: state.rTab === 'Response JSON',
    };
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
  $('agentDeliveries').hidden = true;
  $('tabMenu').open = false;
  setWorkspace(view);
  if (source && view === 'repeater') {
    restorePosition();
    paintRun();
    await updateRuns(true);
  }
  if (view === 'settings') await loadSettings();
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
    await Promise.all([viewWrite, preferenceWrites]);
    const data = await api('tabs/' + action, args);
    await installWorkspace(data, 'repeater');
    if (action === 'delete') {
      tabUndo.delete(args.id);
      tabPositions.delete(args.id);
    }
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
function openField(key, value) {
  if (field?.error) return focusField();
  field = { key, text: value, error: '' };
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
    const editingJson = field?.key === key + '/json';
    const editing = editingJson || field?.key === key;
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
      if (editing) closeField();
      else openField(key + '/json', pretty(currentPart()));
    };
    const toggle = toolButton('{}', editing ? 'Back to preview' : 'Block JSON', source);
    toggle.setAttribute('aria-expanded', String(editing));
    controls.push(
      toggle,
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
    if (editing) {
      if (!editingJson && !field.projection) {
        field.projection = prettyEditorText(field.text);
        field.text = field.projection.text;
      }
      const section = el('section', '', 'contentText');
      const editor = inlineSource(editingJson ? 'Block JSON' : 'Edit text', (text) => {
        const prev = currentPart();
        if (field.projection) text = field.projection.encode(text);
        const next = editingJson
          ? JSON.parse(text)
          : typeof prev === 'string' ? text : { ...prev, text };
        if (
          editingJson &&
          (next == null ||
            (typeof next !== 'object' && typeof next !== 'string') ||
            Array.isArray(next))
        )
          throw Error('A content block must be text or a JSON object.');
        return editedPart(index, i, next);
      });
      section.append(
        sectionTitle(label, controls),
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
      openField(key, text),
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
function chooseDraftView(view) {
  if (view === 'Changes') beforeChanges = dTab;
  else {
    const editorView = field?.key === 'request' ? 'Full JSON' : 'Messages';
    if (field?.error && view !== editorView) {
      dTab = editorView;
      renderDraft();
      return focusField();
    }
    if (view !== editorView) field = null;
  }
  dTab = view;
  renderDraft();
  markDraft();
}
$('draftFormat').onclick = () => chooseDraftView(dTab === 'Full JSON' ? 'Messages' : 'Full JSON');
$('draftChanges').onclick = () => chooseDraftView(dTab === 'Changes' ? beforeChanges : 'Changes');
function renderDraft() {
  if (!draft) return;
  draftStatus();
  $('draftFormat').setAttribute('aria-pressed', String(dTab === 'Full JSON'));
  $('draftChanges').setAttribute('aria-pressed', String(dTab === 'Changes'));
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
function responseContent(reply, protocol = 'chat') {
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
function failurePanel(failure, status, capture) {
  const panel = el('section', '', 'runFailure');
  const heading = { rejected: 'Request rejected', canceled: 'Request canceled',
    unmatched: status === 'failed' ? 'Failed · gateway details unavailable' : 'Completion unconfirmed' }[failure.reason];
  const http = failure.http ? 'Gateway HTTP ' + failure.http : '';
  panel.append(el('strong', [heading, http].filter(Boolean).join(' · ') ||
    (capture ? 'Request failed' : 'No HTTP response')));
  panel.append(el('p', failure.message));
  const facts = el('dl');
  for (const [name, value] of [
    ['Provider', failure.provider], ['Error code', failure.code], ['Error type', failure.type],
    ['Request ID', failure.requestId], ['Retry-After', failure.retryAfter],
  ]) {
    if (value) facts.append(el('dt', name), el('dd', value));
  }
  if (facts.childElementCount) panel.append(facts);
  if (failure.truncated) panel.append(el('small', 'Error body truncated at 8 KiB.'));
  return panel;
}
function hasRawReply(record) {
  return record.response != null || Boolean(record.failure?.raw);
}
function replyContent(record, raw, refresh, hit) {
  const reply = record.response;
  const failure = record.failure;
  if (raw) {
    if (reply != null) return jsonPanel(reply, null, hit);
    if (failure?.raw) {
      const panel = el('div');
      let parsed;
      try {
        parsed = JSON.parse(failure.raw);
      } catch {}
      panel.append(parsed === undefined ? el('pre', failure.raw) : jsonPanel(parsed));
      if (failure.truncated) panel.append(el('small', 'Error body truncated at 8 KiB.'));
      return panel;
    }
  }
  if (failure && ['failed', 'canceled', 'unconfirmed'].includes(record.status)) {
    const panel = el('div');
    panel.append(failurePanel(failure, record.status, record.entry_type === 'capture'));
    if (reply?.output?.length) panel.append(responseContent(reply, record.protocol));
    return panel;
  }
  if (record.recovered_output?.length) {
    const panel = el('div');
    panel.append(
      el('p', 'Output recovered from the local Codex log.', 'hint'),
      responseContent({ ...reply, output: record.recovered_output }, record.protocol),
    );
    return panel;
  }
  return reply != null ? responseContent(reply, record.protocol) : noReply(record, refresh);
}
function chooseRunView(view) {
  runView = { ...runView, ...view };
  saveViewPreference({ id: source.id, ...runView }, 'tabs/run-view');
  paintRun();
}
function paintRun() {
  const inSnapshot = runView.tab === 'Request snapshot';
  $('replyTitle').textContent = runView.tab;
  $('backToReply').hidden = !inSnapshot;
  $('viewSnapshot').hidden = inSnapshot;
  $('viewSnapshot').disabled = !snapshot?.body;
  const s = snapshot || {},
    reply = s.response,
    box = $('runView');
  formatToggle('runFormat', 'reply', runView.tab === 'Reply' && hasRawReply(s), runView.raw,
    () => chooseRunView({ raw: !runView.raw }));
  box.replaceChildren();
  $('restore').disabled = !s.body || posting;
  $('runMeta').textContent = [
    s.ended != null ? ((s.ended - s.started) / 1000).toLocaleString('en', { maximumFractionDigits: 2 }) + ' s' : '',
    reply?.usage?.total_tokens != null ? reply.usage.total_tokens.toLocaleString('en') + ' tokens' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (!snapshot) box.append(el('p', 'Loading…', 'hint'));
  else if (inSnapshot) {
    if (s.body) box.append(jsonPanel(s.body));
  } else box.append(replyContent(s, runView.raw, () => updateRuns(true)));
}
$('viewSnapshot').onclick = () => {
  $('runMenu').open = false;
  chooseRunView({ tab: 'Request snapshot' });
  $('backToReply').focus();
};
$('backToReply').onclick = () => {
  chooseRunView({ tab: 'Reply' });
  $('runMenu').querySelector('summary').focus();
};
async function updateRuns(force = false) {
  if (!source) return;
  const id = source.id,
    epoch = ++runEpoch;
  const [kind, baseId] = source.source_ref.split(':');
  const d = await api('tabs/runs?id=' + id);
  if (epoch !== runEpoch || source?.id !== id) return;
  runs = d.runs;
  saved = d.drafts;
  const receipts = d.dispatches || [];
  const history = $('agentDeliveries');
  history.hidden = !receipts.length;
  if (receipts.length && history.dataset.items !== JSON.stringify(receipts)) {
    history.dataset.items = JSON.stringify(receipts);
    history.replaceChildren(el('summary','Agent deliveries · '+receipts.length),
      ...receipts.map(r=>el('p',[time(r.created),agentName(r.target_agent),r.state,r.session_id,r.error].filter(Boolean).join(' · '))));
  }
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
    (picked === 'original' && ['pending', 'checking', 'checking_unknown', 'queued', 'running'].includes(snapshot?.status))
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
      snapshot = null;
      if (runView.tab !== 'Reply') chooseRunView({ tab: 'Reply' });
      else paintRun();
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
  const id = source.id, previous = runId, picked = $('runSelect').value;
  runId = picked;
  snapshot = null;
  ++runEpoch;
  paintRun();
  try {
    await api('tabs/pick', { id, run: picked });
  } catch (error) {
    if (source?.id === id && runId === picked) {
      runId = previous;
      await updateRuns(true);
    }
    throw error;
  }
  if (source?.id === id && runId === picked) await updateRuns(true);
});
$('restore').onclick = invoke(async () => {
  $('runMenu').open = false;
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
const splitSizes = new Map();
function bindSplitter(split, handle, initial, mode, stacked) {
  function syncSplit() {
    const size = splitSizes.get(mode()) ?? initial;
    split.style.setProperty('--first-share', size + 'fr');
    split.style.setProperty('--second-share', 100 - size + 'fr');
    handle.setAttribute('aria-orientation', stacked?.matches ? 'horizontal' : 'vertical');
    handle.setAttribute('aria-valuenow', String(Math.round(size)));
  }
  function setSplit(percent) {
    const key = mode();
    const size = Math.max(25, Math.min(75, percent));
    if (size === (splitSizes.get(key) ?? initial)) return false;
    splitSizes.set(key, size);
    syncSplit();
    return true;
  }
  function saveSize(key) {
    saveViewPreference({ split: key, percent: splitSizes.get(key) });
  }
  function resize(percent) {
    if (setSplit(percent)) saveSize(mode());
  }
  stacked?.addEventListener('change', syncSplit);
  syncSplit();
  let drag;
  handle.onpointerdown = (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    const rect = handle.getBoundingClientRect();
    drag = {
      key: mode(),
      size: splitSizes.get(mode()) ?? initial,
      offset: stacked?.matches ? e.clientY - rect.top : e.clientX - rect.left,
    };
    handle.setPointerCapture(e.pointerId);
  };
  handle.onpointermove = (e) => {
    if (drag?.key !== mode() || !handle.hasPointerCapture(e.pointerId)) return;
    const rect = split.getBoundingClientRect();
    const extent = stacked?.matches
      ? rect.height - handle.offsetHeight
      : rect.width - handle.offsetWidth;
    const pos = stacked?.matches ? e.clientY - rect.top : e.clientX - rect.left;
    if (extent > 0) setSplit((100 * (pos - drag.offset)) / extent);
  };
  handle.onlostpointercapture = () => {
    if (drag && (splitSizes.get(drag.key) ?? initial) !== drag.size) saveSize(drag.key);
    drag = null;
  };
  handle.ondblclick = () => resize(initial);
  handle.onkeydown = (e) => {
    const size = Number(handle.getAttribute('aria-valuenow'));
    const step = stacked?.matches ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    if (e.key === step[0]) resize(size - 5);
    else if (e.key === step[1]) resize(size + 5);
    else if (e.key === 'Home') resize(25);
    else if (e.key === 'End') resize(75);
    else return;
    e.preventDefault();
  };
  return syncSplit;
}
const syncTraceSplit = bindSplitter(
  $('trace'),
  $('traceHandle'),
  30,
  () => activeGroup ? 'trace-session' : 'trace-flat',
);
const syncTreeSplit = bindSplitter($('traceRight'), $('treeHandle'), 40, () => 'session-tree');
const stackedRepeater = window.matchMedia('(max-width: 760px)');
const syncRepeaterSplit = bindSplitter(
  $('repeatSplit'),
  $('splitHandle'),
  50,
  () => stackedRepeater.matches ? 'repeater-stacked' : 'repeater-wide',
  stackedRepeater,
);
$('filterButton').append(icon('sliders'));
$('pickTrace').onclick = () => $('toTrace').click();
for (const id of ['filterMenu', 'metaMenu', 'tabMenu', 'runMenu']) {
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
  if (switching) return;
  setWorkspace('repeater', true);
  if (repeaterLoaded) {
    if (source) await updateRuns(true);
    return;
  }
  switching = true;
  try {
    const data = await api('tabs/workspace');
    if (workspace === 'repeater') await installWorkspace(data, 'repeater');
  } finally {
    switching = false;
  }
});
$('record').onclick = invoke(async () => {
  $('record').disabled = true;
  try {
    paintRecording(await api('recording', { enabled: !recording }));
    if (workspace === 'trace') await list();
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
    if (field?.error && !event.target.closest('.inlineSource, .editTool[aria-expanded="true"]')) {
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
        if (!next.classList.contains('sessionRow')) await select(next.dataset.id);
      }
    }
  }),
);
async function poll() {
  try {
    if (workspace === 'trace') await list();
    else paintRecording(await api('recording'));
    if (workspace === 'repeater' && !posting && !switching) {
      const current = source;
      const index = await api('tabs/tab-index');
      if (workspace === 'repeater' && !switching && !posting && current === source) {
        const remote = index.tabs.find(t=>t.id===index.active && t.closed===null);
        const changed = remote?.id !== source?.id || remote?.revision !== writer?.revision;
        if (changed && (!writer || writer.settled) && !field) {
          const data = await api('tabs/workspace');
          if (workspace === 'repeater' && !posting && !switching && current === source && (!writer || writer.settled) && !field)
            await installWorkspace(data,'repeater');
        } else if (source) await updateRuns();
      }
    }
  } catch (e) {
    explain(e);
  }
  schedulePoll();
}
function schedulePoll() {
  setTimeout(poll, document.hidden ? 6000 : 2000);
}
async function initialize() {
  document.querySelector('body').inert = true;
  try {
    const [, data] = await Promise.all([prepareReload(), api('tabs/workspace?defer=1')]);
    for (const [key, size] of Object.entries(data.splits ?? {})) {
      if (Number.isFinite(size) && size >= 25 && size <= 75) splitSizes.set(key, size);
    }
    syncTraceSplit();
    syncTreeSplit();
    syncRepeaterSplit();
    if (data.deferred) {
      setWorkspace(data.view);
      if (data.view === 'trace') await list();
      else {
        const [recording] = await Promise.all([api('recording'), loadSettings()]);
        paintRecording(recording);
      }
    } else {
      await Promise.all([
        installWorkspace(data, data.view),
        data.view === 'trace' ? list() : api('recording').then(paintRecording),
      ]);
    }
  } catch (e) {
    explain(e);
  } finally {
    document.querySelector('body').inert = false;
    schedulePoll();
  }
}
initialize();
