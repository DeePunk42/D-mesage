import { toolLabel, itemLabel, phaseLabel, resultParts } from './response-items.js';
import { isTextBlock } from './protocols.js';
import { compactText, messagePreview, presentation } from './messages.js';
import { promptSections, promptTokens } from './prompt-syntax.js';
export const pretty = (v) => JSON.stringify(v, null, 2);
export function el(tag, text = '', cls = '') {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
export function button(label, fn, cls = '') {
  const b = el('button', label, cls);
  b.type = 'button';
  b.onclick = fn;
  return b;
}
export function roleBadge(role) {
  const badge = el('span', role || 'Unknown', 'role');
  if (['user', 'system', 'developer', 'assistant', 'tool', 'function'].includes(role))
    badge.dataset.role = role;
  return badge;
}
function treeNode(key, v, open = false, path = [], hit = null) {
  const obj = v !== null && typeof v === 'object';
  const target = hit && path.length === hit.path.length;
  open ||= !!hit;
  const long = !obj && typeof v === 'string' && (v.length > 180 || v.includes('\n'));
  const n = el(obj || long ? 'details' : 'div', '', 'jnode');
  const head = obj || long ? el('summary') : n;
  function showMatch(node, text) {
    const start = hit.start;
    node.replaceChildren(
      text.slice(0, start),
      el('mark', text.slice(start, start + hit.term.length)),
      text.slice(start + hit.term.length),
    );
  }
  if (target) n.classList.add('searchTarget');
  if (key != null) {
    const keyNode = el('span', key, 'jkey');
    if (target && hit.inKey) showMatch(keyNode, String(key));
    head.append(keyNode, el('span', '  ', 'muted'));
  }
  if (!obj && !long) {
    const code = el('code', pretty(v), typeof v === 'string' ? 'jstring' : 'jvalue');
    if (target && !hit.inKey) showMatch(code, String(v));
    head.append(code);
    return n;
  }
  head.append(
    el(
      'code',
      obj
        ? Array.isArray(v)
          ? '[' + v.length + ']'
          : '{' + Object.keys(v).length + '}'
        : compactText(v, 65) || '""',
      'jcount',
    ),
  );
  n.append(head);
  let filled = false;
  function fill() {
    if (filled) return;
    filled = true;
    if (long) {
      const literal = el('pre', v, 'literal');
      if (target && !hit.inKey) showMatch(literal, v);
      n.append(literal);
    } else {
      const children = el('div', '', 'children');
      for (const [k, child] of Object.entries(v)) {
        const segment = Array.isArray(v) ? Number(k) : k;
        children.append(
          treeNode(
            k,
            child,
            false,
            [...path, segment],
            hit?.path[path.length] === segment ? hit : null,
          ),
        );
      }
      n.append(children);
    }
  }
  n.ontoggle = () => {
    if (n.open) fill();
  };
  if (open) {
    fill();
    n.open = true;
  }
  return n;
}
export function jsonTree(v, key = null, hit = null) {
  const tree = el('div', '', 'jsonTree');
  tree.append(treeNode(key, v, true, [], hit));
  return tree;
}
function colored(text, tag = 'pre', includeFences = true) {
  const node = el(tag, '', 'highlight');
  let plain = '';
  for (const [value, type] of promptTokens(text, includeFences)) {
    if (!type) plain += value;
    else if (value) {
      if (plain) node.append(plain);
      node.append(el('span', value, type));
      plain = '';
    }
  }
  if (plain) node.append(plain);
  return node;
}
export function showText(value) {
  if (typeof value !== 'string') return jsonTree(value);
  const { data, text } = presentation(value);
  if (data !== undefined) return jsonTree(data, 'JSON');
  const out = el('div', '', 'textBody');
  for (const section of promptSections(text)) {
    if (!section.marker) {
      out.append(colored(text.slice(section.start, section.end), 'pre', false));
      continue;
    }
    const block = el('details', '', 'codeBlock');
    block.open = true;
    block.append(
      el('summary', section.label || 'Code'),
      el('pre', text.slice(section.codeStart, section.codeEnd)),
    );
    out.append(block);
  }
  if (!out.childNodes.length) out.append(el('pre', '(empty string)'));
  return out;
}
export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg',
    svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const d = {
    undo: 'M4 9h9a6 6 0 0 1 0 12 M4 9l5-5 M4 9l5 5',
    redo: 'M20 9h-9a6 6 0 0 0 0 12 M20 9l-5-5 M20 9l-5 5',
    sliders: 'M3 7h8m4 0h6 M3 17h3m4 0h11 M11 4v6 M7 14v6',
    agents:
      'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm4-4a4 4 0 0 1 0 8',
    trash: 'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
    wrench: 'M14 6a5 5 0 0 0-6 6L3 17a2.2 2.2 0 0 0 3 3l6-6a5 5 0 0 0 6-6l-3 3-3-3 3-3Z',
    pretty: 'm4 20 10-10 3 3L7 23z M16 3v4m-2-2h4 M6 4v6M3 7h6 M20 14v4m-2-2h4',
    raw: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  };
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d[name]);
  svg.append(p);
  return svg;
}
export function textBlock(label, value, controls = []) {
  const block = el('section', '', 'contentText'),
    head = sectionTitle(label);
  const modes = el('span', '', 'viewModes'),
    view = el('div', '', 'contentView');
  function display(raw) {
    block.dataset.mode = raw ? 'raw' : 'pretty';
    prettyButton.setAttribute('aria-pressed', !raw);
    rawButton.setAttribute('aria-pressed', raw);
    view.replaceChildren(raw ? el('pre', value, 'rawContent') : showText(value));
  }
  const prettyButton = button('', () => display(false)),
    rawButton = button('', () => display(true));
  for (const [b, name, label] of [
    [prettyButton, 'pretty', 'Pretty'],
    [rawButton, 'raw', 'Raw'],
  ]) {
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(icon(name));
    modes.append(b);
  }
  head.append(modes, ...controls);
  block.append(head, view);
  display(false);
  return block;
}
function toolNames(msg, lookup) {
  const names = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map(
    (c) => c?.function?.name || c?.name,
  );
  if (msg.function_call) names.push(msg.function_call.name);
  if (['tool', 'function'].includes(msg.role))
    names.push(msg.name || toolLabel(lookup?.get(msg.tool_call_id)));
  if (Array.isArray(msg.content))
    for (const b of msg.content) {
      if (
        ['tool_use', 'server_tool_use', 'tool_call', 'function_call', 'custom_tool_call'].includes(
          b?.type,
        )
      )
        names.push(toolLabel(b));
      else if (b?.type === 'web_search_call') names.push('web_search');
      else if (b?.type === 'tool_search_call' || b?.type === 'tool_search_output')
        names.push('tool_search');
      else if (
        b?.type === 'tool_result' ||
        (typeof b?.type === 'string' && b.type.endsWith('_call_output'))
      )
        names.push(toolLabel(lookup?.get(b.tool_use_id || b.call_id)));
    }
  return [...new Set(names.filter((n) => typeof n === 'string' && n))];
}
function disclosure(label, render) {
  const details = el('details', '', 'itemDetails');
  details.append(el('summary', label));
  details.ontoggle = () => {
    if (details.open && details.childElementCount === 1) details.append(render());
  };
  return details;
}
function imageResult(block) {
  const source = block.image_url?.url ?? block.image_url;
  // Loading a recorded remote URL would contact the original site during inspection.
  if (typeof source !== 'string' || !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(source))
    return el('span', 'Image reference');
  return disclosure('Preview image', () => {
    const img = el('img');
    img.alt = 'Captured tool result';
    img.className = 'capturedImage';
    img.src = source;
    return img;
  });
}
export function blockData(p, lookup) {
  if (!p || typeof p !== 'object') return jsonTree(p);
  const label = itemLabel(p, lookup);
  const raw = () => disclosure('Raw item', () => jsonTree(p));
  if (p.type === 'reasoning') {
    const group = el('div');
    for (const part of Array.isArray(p.summary) ? p.summary : [])
      group.append(isTextBlock(part) ? showText(part.text ?? part) : jsonTree(part));
    if (!group.childElementCount) group.append(el('small', label));
    group.append(raw());
    return group;
  }
  if (
    [
      'compaction_trigger',
      'compaction',
      'configuration_update',
      'web_search_call',
      'tool_search_call',
      'tool_search_output',
      'additional_tools',
    ].includes(p.type)
  ) {
    const group = el('div');
    group.append(el('b', label), raw());
    return group;
  }
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    const call = lookup?.get(p.call_id);
    const group = el('div', '', 'toolEntry');
    const title = el('div', '', 'toolTitle');
    title.append(
      icon('wrench'),
      el('b', call ? compactText(itemLabel(call) || toolLabel(call)) : 'Tool result'),
    );
    group.append(title);
    for (const part of resultParts(p, call)) {
      if (part.status) group.append(el('small', part.status, 'resultStatus'));
      if (part.image) group.append(imageResult(part.image));
      else if (part.text) group.append(showText(part.text));
      else if (part.value != null) group.append(jsonTree(part.value));
    }
    group.append(raw());
    return group;
  }
  if (
    ['function_call', 'custom_tool_call', 'tool_use', 'server_tool_use', 'tool_result'].includes(
      p.type,
    )
  ) {
    const group = el('div', '', 'toolEntry'),
      title = el('div', '', 'toolTitle');
    const id = p.tool_use_id || p.call_id || p.id;
    title.append(
      icon('wrench'),
      el('b', label ? compactText(label) : toolLabel(p) || toolLabel(lookup?.get(id)) || p.type),
    );
    if (id) title.append(el('small', id));
    group.append(title);
    const value = p.arguments ?? p.input ?? p.output ?? p.content;
    if (Array.isArray(value))
      for (const b of value) group.append(isTextBlock(b) ? showText(b.text ?? b) : jsonTree(b));
    else group.append(showText(value ?? p));
    if (p.is_error) group.append(el('small', 'Tool error'));
    return group;
  }
  if (p.type === 'thinking' && typeof p.thinking === 'string') return showText(p.thinking);
  return jsonTree(p);
}
export function sectionTitle(label, items = []) {
  const n = el('div', '', 'fieldhead');
  n.append(el('strong', label), ...items);
  return n;
}
export function messageCard(msg, index, open, actions, lookup) {
  const card = el('details', '', 'messageCard');
  const type = msg.type === 'additional_tools' ? msg.type : msg.content?.[0]?.type;
  if (
    !actions &&
    ['compaction', 'compaction_trigger', 'reasoning', 'additional_tools'].includes(type)
  )
    open = false;
  card.open = open;
  const head = el('summary');
  const badge = roleBadge(msg.role);
  let editBar;
  const names = toolNames(msg, lookup);
  const snippet = names.length && msg.content == null ? '' : messagePreview(msg, lookup);
  head.append(
    el('span', String(index + 1).padStart(2, '0'), 'index'),
    badge,
    ...(phaseLabel(msg) ? [el('small', phaseLabel(msg), 'phaseBadge')] : []),
    el('span', snippet || (names.length ? '' : 'No content'), 'snippet'),
  );
  if (names.length) {
    const tools = el('span', '', 'toolNames');
    for (const name of names) {
      const label = el('span', '', 'toolName');
      label.title = name;
      label.append(icon('wrench'), el('span', name));
      tools.append(label);
    }
    head.append(tools);
  } else if (msg.name) head.append(el('small', msg.name));
  card.append(head);
  let filled = false;
  function fill() {
    if (filled) return;
    filled = true;
    const body = el('div', '', 'messageBody');

    if (actions?.messageSource(body, index)) {
      card.append(body);
      return;
    }
    if (msg.type === 'additional_tools') {
      body.append(blockData(msg, lookup));
      card.append(body);
      return;
    }
    const arr = Array.isArray(msg.content),
      parts = arr ? msg.content : msg.content == null ? [] : [msg.content];
    if (!parts.length && !names.length)
      body.append(
        sectionTitle('content'),
        el('small', arr ? 'Empty array' : Object.hasOwn(msg, 'content') ? 'null' : 'Not provided'),
      );
    for (const [i, p] of parts.entries()) {
      const type = typeof p === 'string' ? 'text' : p?.type || 'JSON';
      const label = arr
        ? 'content[' + i + '] · ' + type
        : type === 'text'
          ? 'content'
          : 'content · ' + type;
      if (actions) {
        body.append(actions.part(index, i, p, label));
        continue;
      }
      if (isTextBlock(p)) {
        body.append(textBlock(label, typeof p === 'string' ? p : p.text));
        if (typeof p === 'object') {
          const extra = Object.fromEntries(
            Object.entries(p).filter(([k]) => k !== 'type' && k !== 'text'),
          );
          if (Object.keys(extra).length) body.append(jsonTree(extra, 'Block attributes'));
        }
      } else body.append(sectionTitle(label), blockData(p, lookup));
    }
    const attributes = {};
    for (const [name, v] of Object.entries(msg)) {
      if (
        msg.type === 'message' &&
        ['type', 'status', 'id', 'metadata', 'internal_chat_message_metadata_passthrough'].includes(
          name,
        )
      ) {
        attributes[name] = v;
        continue;
      }
      if (name === 'role' || name === 'content' || (name === 'phase' && phaseLabel(msg))) continue;
      if ((name === 'tool_calls' && Array.isArray(v)) || (name === 'function_call' && v)) {
        const calls = name === 'tool_calls' ? v : [{ function: v }];
        if (calls.length) {
          const group = el('div', '', 'toolGroup');
          group.append(sectionTitle('Tool calls'));
          for (const t of calls) {
            const f = t?.function,
              entry = el('div', '', 'toolEntry');
            const title = el('div', '', 'toolTitle');
            title.append(icon('wrench'), el('b', f?.name || t?.name || 'tool'));
            if (t?.id) title.append(el('small', t.id));
            entry.append(title);
            if (f?.arguments != null) entry.append(showText(f.arguments));
            else entry.append(jsonTree(t));
            group.append(entry);
          }
          body.append(group);
        }
      } else body.append(sectionTitle(name), showText(v));
    }
    if (Object.keys(attributes).length)
      body.append(disclosure('Message attributes', () => jsonTree(attributes)));
    card.append(body);
  }
  function updateHeader() {
    if (!actions) return;
    if (card.open) {
      editBar ??= actions.messageBar(msg, index);
      badge.replaceWith(editBar);
    } else editBar?.replaceWith(badge);
  }
  if (open) {
    updateHeader();
    fill();
  }
  card.ontoggle = () => {
    updateHeader();
    if (card.open) fill();
    if (card.isConnected) actions?.toggled(index, card.open);
  };
  return card;
}

// Keep a native textarea for selection, input methods and undo. The matching
// paint layer is visual only, and it follows the textarea's scroll position.
export function highlightedEditor(box) {
  const wrap = el('div', '', 'prettyEditor'),
    paint = el('pre', '', 'editorPaint');
  paint.setAttribute('aria-hidden', 'true');
  function syncScroll() {
    paint.scrollTop = box.scrollTop;
    paint.scrollLeft = box.scrollLeft;
  }
  function draw() {
    paint.replaceChildren(colored(box.value, 'span'), '\u200b');
    syncScroll();
  }
  wrap.append(paint, box);
  box.addEventListener('input', draw);
  box.addEventListener('scroll', syncScroll);
  draw();
  return wrap;
}
