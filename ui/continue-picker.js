import { button, el } from './views.js';

export function continuePicker({
  root,
  menu,
  choices,
  launch,
  message,
  api,
  agentIcon,
  agentName,
  currentRequest,
  savedRevision,
}) {
  let run = null,
    options = null,
    target = '',
    busy = false,
    key = null,
    sentDraft = null,
    timer = null;
  let tab = null,
    generation = 0,
    loading = false;
  function targetHint() {
    const selected = options?.targets.find((t) => t.id === target);
    if (selected?.reason) return selected.reason;
    if (
      selected &&
      options.original !== target &&
      !(target === 'claude' && options.original === 'claude-code')
    )
      return 'Send the current user message to a new ' + agentName(target) + ' session.';
    if (target === 'claude')
      return 'Send the current request draft to a native Claude Code background session.';
    if (target === 'dsh' || target === 'codex')
      return 'Fork the source chat and send the current user message.';
    return '';
  }
  function render() {
    root.hidden = !run;
    if (!run) return;
    const selected = options?.targets.find((t) => t.id === target);
    launch.replaceChildren(
      agentIcon(selected?.id),
      document.createTextNode(
        selected?.id === 'dsh'
          ? 'Send to DSH'
          : selected
            ? 'Send to ' + agentName(selected.id)
            : 'Send to agent',
      ),
    );
    launch.disabled = loading || busy || !selected || !!selected.reason;
    launch.title =
      targetHint() ||
      (target === 'dsh'
        ? 'Send the user prompt to a branch in the connected Host. DSH uses its own model and tools.'
        : 'Use this run’s conversation and model settings in a new chat with the target agent’s native instructions and tools.');
    choices.replaceChildren();
    for (const t of options?.targets || []) {
      const row = button('', () => {
        clearTimeout(timer);
        target = t.id;
        key = null;
        menu.open = false;
        message.textContent = '';
        render();
        menu.querySelector('summary').focus();
      });
      row.disabled = !!t.reason || busy;
      row.setAttribute('aria-pressed', String(t.id === target));
      row.append(agentIcon(t.id), el('span', agentName(t.id), 'modelLabel'));
      if (t.id === options.original) row.append(el('small', 'Original'));
      if (t.reason) row.append(el('small', t.reason, 'agentUnavailable'));
      choices.append(row);
    }
    if (selected?.reopen && !busy) {
      const row = button('Reopen last chat', async () => {
        const g = generation;
        menu.open = false;
        busy = true;
        render();
        try {
          await api('continue/' + run, { target, reopen: selected.reopen });
          if (g === generation) message.textContent = 'Opening the previous chat…';
        } catch (e) {
          if (g === generation) message.textContent = e.message;
        } finally {
          if (g === generation) {
            busy = false;
            render();
          }
        }
      });
      choices.append(row);
    }
    if (!options && !loading) choices.append(button('Retry loading agents', load));
    if (options && !options.targets.length)
      choices.append(el('p', 'No supported agents available.', 'hint'));
  }
  async function load() {
    if (!run || loading) return;
    const g = generation;
    loading = true;
    render();
    try {
      const data = await api('continue/' + run);
      if (g !== generation) return;
      options = data;
      if (!options.targets.some((item) => item.id === target)) {
        const preferred =
          options.targets.find((item) => item.id === data.original) ??
          options.targets.find((item) => !item.reason) ??
          options.targets[0];
        target = preferred?.id ?? '';
      }
    } catch (e) {
      if (g === generation) message.textContent = e.message;
    } finally {
      if (g === generation) {
        loading = false;
        render();
      }
    }
  }
  async function watchClaude(id, job, g) {
    if (generation !== g || busy || target !== 'claude') return;
    try {
      const state = await api('continue-status/' + id);
      if (generation !== g || busy || target !== 'claude') return;
      const handle = state.job || job;
      const status =
        {
          approval: 'Waiting for Claude Code approval',
          waiting: 'Claude Code needs input',
          idle: 'Claude Code is idle',
          busy: 'Claude Code is working',
          stopped: 'Claude Code stopped',
          blocked: 'Claude Code needs attention',
        }[state.activity] || 'Claude Code job ' + (state.activity || 'started');
      message.textContent = status + ' · claude attach ' + handle;
      if (state.activity === 'busy') timer = setTimeout(() => watchClaude(id, job, g), 3500);
    } catch {
      if (generation === g && !busy && target === 'claude')
        message.textContent = 'Check the Claude Code job · claude attach ' + job;
    }
  }
  launch.onclick = async () => {
    if (!run || busy || launch.disabled) return;
    const g = ++generation,
      current = run,
      agent = target;
    clearTimeout(timer);
    busy = true;
    menu.open = false;
    render();
    try {
      const request = currentRequest();
      if (request !== sentDraft) key = null;
      sentDraft = request;
      key ??= crypto.randomUUID();
      const revision = await savedRevision();
      if (g !== generation) return;
      const s = await api('continue/' + current, {
        target: agent,
        key,
        tab_ref: 'tab:' + tab,
        revision,
      });
      if (g !== generation) return;
      if (agent === 'codex') {
        message.textContent = 'Message queued in Codex · ' + s.sessionId;
        busy = false;
        key = null;
        render();
        return;
      }
      if (agent === 'claude') {
        message.textContent =
          'Started in Claude Code · ' + (s.job ? 'claude attach ' + s.job : s.sessionId);
        busy = false;
        key = null;
        render();
        if (s.job) timer = setTimeout(() => watchClaude(s.id, s.job, g), 2000);
        return;
      }
      if (agent === 'dsh') {
        message.textContent = 'Prompt accepted in DSH · ' + s.sessionId;
        busy = false;
        key = null;
        render();
        return;
      }
    } catch (e) {
      if (g === generation) {
        if (e.dispatchState === 'failed') key = null;
        message.textContent = e.message;
        busy = false;
        render();
      }
    }
  };
  menu.ontoggle = () => {
    if (menu.open && !busy) void load();
  };
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
  function view(source) {
    const tabId = source?.id;
    const next = source?.call_id ? 'capture/' + source.call_id : null;
    if (next === run && tabId === tab) return;
    generation++;
    clearTimeout(timer);
    if (tab !== tabId || !target) target = source?.agent || '';
    tab = tabId;
    run = next;
    options = null;
    key = null;
    busy = loading = false;
    menu.open = false;
    message.textContent = '';
    render();
    if (run) void load();
  }
  return { view, refresh: load };
}
