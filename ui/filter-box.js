import { searchQuery, splitConditions } from './search.js';
import { button, el } from './views.js';

export function filterBox(input, chips, menu, onChange) {
  const conditions = [];
  const suggestions = [
    ['request:', 'Request body'],
    ['response:', 'Response body'],
    ['tool:', 'Tool calls and results'],
  ];
  let active = -1,
    composing = false;
  function query() {
    const tail = input.value.trim();
    return [...conditions, ...(searchQuery(tail).term ? [tail] : [])].join(' ');
  }
  function showMenu(show) {
    menu.hidden = !show;
    input.setAttribute('aria-expanded', String(show));
    active = -1;
    input.removeAttribute('aria-activedescendant');
    for (const option of menu.children) option.setAttribute('aria-selected', 'false');
  }
  function refreshMenu() {
    menu.replaceChildren();
    const partial = input.value.toLowerCase();
    for (const [prefix, description] of suggestions.filter(
      ([prefix]) => prefix.startsWith(partial) && prefix !== partial,
    )) {
      const option = button('', () => {
        input.value = prefix;
        input.focus();
        showMenu(false);
        onChange();
      });
      option.setAttribute('role', 'option');
      option.id = 'suggest-' + prefix.slice(0, -1);
      option.tabIndex = -1;
      option.append(el('code', prefix), el('small', description));
      option.onmousedown = (event) => event.preventDefault();
      menu.append(option);
    }
    showMenu(!!menu.childElementCount && document.activeElement === input);
  }
  function renderChips() {
    chips.replaceChildren();
    conditions.forEach((raw, index) => {
      const chip = el('span', '', 'filterChip');
      const edit = button(raw, () => {
        if (input.value.trim() && searchQuery(input.value).term)
          conditions.push(input.value.trim());
        conditions.splice(index, 1);
        input.value = raw;
        renderChips();
        input.focus();
        refreshMenu();
        onChange();
      });
      edit.title = 'Edit ' + raw;
      const remove = button('×', () => {
        conditions.splice(index, 1);
        renderChips();
        input.focus();
        refreshMenu();
        onChange();
      });
      remove.setAttribute('aria-label', 'Remove ' + raw);
      chip.append(edit, remove);
      chips.append(chip);
    });
    input.placeholder = conditions.length ? 'Add filter' : 'Search traces';
  }
  function consume() {
    const { complete, tail } = splitConditions(input.value);
    if (complete.length) {
      const tokens = complete.filter((token) => searchQuery(token).term);
      conditions.push(...tokens);
      input.value = !tail && !searchQuery(complete.at(-1)).term ? complete.at(-1) : tail;
      renderChips();
    }
    refreshMenu();
    if (complete.length && !input.value) showMenu(false);
    onChange();
  }
  input.oninput = () => {
    if (!composing) consume();
  };
  input.oncompositionstart = () => {
    composing = true;
    showMenu(false);
  };
  input.oncompositionend = () => {
    composing = false;
    consume();
  };
  input.onfocus = input.onclick = refreshMenu;
  input.onblur = () => showMenu(false);
  input.onkeydown = (event) => {
    if (event.isComposing || composing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      showMenu(false);
      return;
    }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      if (menu.hidden) refreshMenu();
      if (menu.hidden) return;
      event.preventDefault();
      active =
        (active + (event.key === 'ArrowDown' ? 1 : -1) + menu.children.length) %
        menu.children.length;
      Array.from(menu.children).forEach((node, index) =>
        node.setAttribute('aria-selected', String(index === active)),
      );
      input.setAttribute('aria-activedescendant', menu.children[active].id);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!menu.hidden && active >= 0) menu.children[active].click();
      else if (searchQuery(input.value).term && !splitConditions(input.value).quoted) {
        input.value += ' ';
        consume();
      }
    } else if (event.key === 'Backspace' && !input.value && conditions.length) {
      event.preventDefault();
      input.value = conditions.pop();
      renderChips();
      refreshMenu();
      onChange();
    }
  };
  return { query };
}
