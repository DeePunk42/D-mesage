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
  confirmRead,
  currentRequest,
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
    return (
      options?.targets.find((t) => t.id === target)?.reason ||
      (target === 'dsh'
        ? 'Fork the source chat and resend its user prompt for a new answer.'
        : options?.command
          ? 'New chat workspace · ' + options.command
          : '')
    );
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
        const preferred = options.targets.find((item) => item.id === data.original)
          ?? options.targets.find((item) => !item.reason)
          ?? options.targets[0];
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
  async function watch(id, g, since = Date.now()) {
    if (g !== generation) return;
    try {
      const s = await api('continue-status/' + id);
      if (g !== generation) return;
      if (s.state === 'opening' || s.toolReceipt === 'pending') {
        if (s.toolReceipt === 'pending')
          message.textContent =
            'Answer sent. Waiting for ' + agentName(target) + ' to return the tool result…';
        if (Date.now() - since < 120000) {
          timer = setTimeout(() => watch(id, g, since), 1500);
        } else {
          message.textContent =
            'Still waiting. Check the agent window, or click again to check status.';
          busy = false;
          render();
        }
        return;
      }
      if (s.state !== 'delivered') message.textContent = s.error || 'Agent could not start.';
      else if (s.toolReceipt === 'error')
        message.textContent = agentName(target) + ' reported a tool error.';
      else if (s.toolReceipt === 'returned')
        message.textContent = agentName(target) + ' returned the tool result.';
      else message.textContent = 'Answer sent to ' + agentName(target) + '.';
      busy = false;
      key = null;
      render();
    } catch (e) {
      if (g === generation) {
        message.textContent = e.message;
        busy = false;
        render();
      }
    }
  }
  launch.onclick = async () => {
    if (!run || busy || launch.disabled) return;
    const g = generation,
      current = run,
      agent = target;
    busy = true;
    menu.open = false;
    render();
    try {
      if (!['codex','dsh'].includes(agent) && options.read && !(await confirmRead(agent, options.read))) {
        if (g === generation) {
          busy = false;
          render();
        }
        return;
      }
      if (g !== generation) return;
      const direct = agent === 'codex' || agent === 'dsh';
      const request = direct ? currentRequest() : undefined;
      if (request !== sentDraft) key = null;
      sentDraft = request;
      key ??= crypto.randomUUID();
      const s = await api('continue/' + current, {
        target: agent,
        key,
        ...(direct ? {request} : {approvedFile: options.read}),
      });
      if (g !== generation) return;
      if (agent === 'codex') {
        message.textContent = 'Message queued in Codex · ' + s.sessionId;
        busy = false;
        key = null;
        render();
        return;
      }
      if (agent === 'dsh') {
        message.textContent = 'Prompt accepted in DSH · ' + s.sessionId;
        busy = false;
        key = null;
        render();
        return;
      }
      message.textContent = 'Waiting for ' + agentName(agent) + '…';
      void watch(s.id, g);
    } catch (e) {
      if (g === generation) {
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
  function view(source, selected) {
    const tabId = source?.id;
    const completedRun = selected?.entry_type === 'repeater' && selected.kind === 'send' && selected.status === 'complete';
    const direct = source?.agent === 'codex' || source?.agent === 'dsh';
    const next = completedRun ? selected.id : direct ? 'capture/' + source.call_id : null;
    if (next === run && tabId === tab) return;
    generation++;
    clearTimeout(timer);
    if (tab !== tabId || !target) target = source?.agent || selected?.agent || '';
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
