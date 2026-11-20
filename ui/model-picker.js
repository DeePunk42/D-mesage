import { el, button } from './views.js';

const marks = [
  [/deepseek/i, 'deepseek-color'], [/gpt|openai|codex|\bo[134]\b/i, 'openai'],
  [/claude|anthropic/i, 'claude'], [/gemini|gemma/i, 'gemini-color'],
  [/qwen/i, 'qwen-color'], [/kimi|moonshot/i, 'kimi'], [/grok/i, 'grok'],
  [/mistral|codestral/i, 'mistral-color'], [/minimax/i, 'minimax-color'], [/glm|zai/i, 'zai'],
];

function modelIcon(model) {
  const family = model.name + ' ' + model.id.split('/').at(-1);
  const mark = marks.find(([pattern]) => pattern.test(family)) ||
    marks.find(([pattern]) => pattern.test(model.group));
  if (!mark) return el('span', model.name.slice(0, 1).toUpperCase(), 'modelInitial');
  const img = el('img');
  img.alt = '';
  img.src = 'icons/' + mark[1] + '.svg';
  return img;
}

export function modelPicker({ menu, search, list, load, current, original, pick }) {
  let models = [], notice = '', epoch = 0;
  function render() {
    const groups = new Map();
    const active = current(), seed = original(), needle = search.value.trim().toLowerCase();
    for (const m of models) {
      if (![m.id, m.name, m.group].some((v) => v.toLowerCase().includes(needle))) continue;
      if (!groups.has(m.group)) groups.set(m.group, []);
      groups.get(m.group).push(m);
    }
    list.replaceChildren();
    if (notice) list.append(el('p', notice, 'hint'));
    for (const [group, entries] of groups) {
      const section = el('section');
      section.setAttribute('aria-label', group);
      section.append(el('h3', group));
      for (const m of entries) {
        const row = button('', () => {
          pick(m.id);
          menu.open = false;
          menu.querySelector('summary').focus();
        });
        row.title = m.id;
        row.setAttribute('aria-pressed', String(m.id === active));
        row.append(modelIcon(m), el('span', m.name, 'modelLabel'));
        if (m.id === seed) row.append(el('small', 'Original'));
        if (m.id === active) row.append(el('span', '✓', 'modelCheck'));
        section.append(row);
      }
      list.append(section);
    }
    if (!groups.size && !notice) list.append(el('p', 'No matching models.', 'hint'));
  }
  menu.ontoggle = async () => {
    const request = ++epoch;
    if (!menu.open) return;
    search.value = '';
    models = [];
    notice = 'Loading models…';
    render();
    search.focus();
    try {
      const result = await load();
      if (epoch !== request || !menu.open) return;
      models = result.models;
      notice = '';
    } catch {
      if (epoch !== request || !menu.open) return;
      notice = 'Magpie model list unavailable. Reopen to retry.';
    }
    render();
  };
  search.oninput = render;
  menu.onkeydown = (event) => {
    if (!menu.open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      menu.open = false;
      menu.querySelector('summary').focus();
    } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const rows = [...list.querySelectorAll('button')];
      const i = rows.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? i + 1 : (i < 0 ? 0 : i) - 1;
      rows.at(next % rows.length)?.focus();
    } else if (event.key === 'Enter' && event.target === search) {
      event.preventDefault();
      list.querySelector('button')?.click();
    }
  };
  document.addEventListener('pointerdown', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
}
