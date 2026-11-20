export function splitConditions(input) {
  const complete = [];
  let start = 0,
    quoted = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted && char === '\\' && ['"', '\\'].includes(input[index + 1])) index++;
    else if (char === '"' && (quoted || index === start || input[index - 1] === ':'))
      quoted = !quoted;
    else if (!quoted && /\s/.test(char)) {
      if (index > start) complete.push(input.slice(start, index));
      start = index + 1;
    }
  }
  return { complete, tail: input.slice(start), quoted };
}

export function searchQuery(input) {
  const match = /^(request|response|tool):\s*/i.exec(input.trim());
  let term = input
    .trim()
    .slice(match?.[0].length || 0)
    .trim();
  if (term.startsWith('"'))
    term = term
      .slice(1)
      .replace(/(?<!\\)"$/, '')
      .replace(/\\(["\\])/g, '$1');
  return { scope: match?.[1].toLowerCase() || 'all', term, needle: term.toLowerCase() };
}

export function searchConditions(input) {
  const { complete, tail } = splitConditions(input);
  return [...complete, tail].map(searchQuery).filter((query) => query.needle);
}
export function pointer(path) {
  return path.length
    ? '/' + path.map((key) => String(key).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')
    : '(root)';
}

function toolItem(value) {
  return (
    typeof value?.type === 'string' &&
    /^(?:tool_use|tool_result|tool_search_output|server_tool_use|(?:\w+_)?call(?:_output)?|\w+_tool_result)$/.test(
      value.type,
    )
  );
}

function* toolRoots(body) {
  function* message(value, path) {
    if (!value || typeof value !== 'object') return;
    if (value.role === 'tool' || value.role === 'function' || toolItem(value)) {
      yield [value, path];
      return;
    }
    for (const key of ['tool_calls', 'function_call']) {
      if (value[key] != null) yield [value[key], [...path, key]];
    }
    if (Array.isArray(value.content)) {
      for (const [index, block] of value.content.entries()) {
        if (toolItem(block)) yield [block, [...path, 'content', index]];
      }
    }
  }
  yield* message(body, []);
  for (const key of ['messages', 'input', 'output']) {
    if (Array.isArray(body?.[key])) {
      for (const [index, value] of body[key].entries()) yield* message(value, [key, index]);
    }
  }
  if (Array.isArray(body?.choices)) {
    for (const [index, choice] of body.choices.entries())
      yield* message(choice?.message, ['choices', index, 'message']);
  }
}

function* visit(value, path, side, query, skip) {
  const key = path.at(-1);
  const text = value !== null && typeof value === 'object' ? '' : String(value);
  const offset = text.toLowerCase().indexOf(query.needle);
  if (offset >= 0 || (typeof key === 'string' && key.toLowerCase().includes(query.needle))) {
    const inKey = offset < 0,
      content = inKey ? key : text;
    const start = inKey ? content.toLowerCase().indexOf(query.needle) : offset;
    yield {
      term: query.term,
      side,
      path,
      inKey,
      start,
      preview: content.slice(Math.max(0, start - 32), start + query.term.length + 64),
    };
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries())
      yield* visit(child, [...path, index], side, query);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value))
      if (!skip?.has(key)) yield* visit(value[key], [...path, key], side, query);
  }
}

export function* searchHits(body, side, query) {
  if (!query.needle || body == null || !['all', 'tool', side].includes(query.scope)) return;
  for (const [value, path] of query.scope === 'tool' ? toolRoots(body) : [[body, []]])
    yield* visit(value, path, side, query);
}

const metadataTypes = new Set([
  'additional_tools',
  'configuration_update',
  'compaction_trigger',
  'compaction',
]);
const rawItemFields = new Set([
  'encrypted_content',
  'metadata',
  'internal_chat_message_metadata_passthrough',
]);
function backgroundItem(item) {
  if (['developer', 'system'].includes(item?.role) || metadataTypes.has(item?.type)) return true;
  const text = item?.content?.[0]?.text;
  return (
    item?.role === 'user' &&
    typeof text === 'string' &&
    /^\s*<(?:environment_context|app-context|external_codex_apps_open_page)\b/.test(text)
  );
}

// Keep the wire paths even when the display order differs. Both the worker's first
// result and the inspector's Next / Previous walk this same iterator.
export function* rankedHits(request, response, query, kept) {
  if (!Array.isArray(request?.input)) {
    yield* searchHits(request, 'request', query);
    yield* searchHits(response, 'response', query);
    return;
  }
  const input = request.input;
  const recent = Number.isInteger(kept) ? kept : Math.max(0, input.length - 1);
  const wantsInput = query.scope !== 'response';
  // A result may be the only new item. Its named call can be in the retained prefix.
  const paired = new Set();
  const ids = new Set();
  if (wantsInput) {
    for (let i = recent; i < input.length; i++) {
      if (input[i]?.type?.endsWith?.('_output') && input[i].call_id) ids.add(input[i].call_id);
    }
    for (let i = recent - 1; i >= 0 && ids.size; i--) {
      if (input[i]?.type?.endsWith?.('_call') && ids.delete(input[i].call_id)) paired.add(i);
    }
  }
  const rawFields = [];
  function* itemHits(item, index, side, key) {
    if (query.scope === 'tool' && !toolItem(item)) return;
    const path = [key, index];
    yield* visit(item, path, side, query, rawItemFields);
    for (const field of rawItemFields) {
      if (item && Object.hasOwn(item, field)) rawFields.push([item[field], [...path, field], side]);
    }
  }
  function* inputs(from, to, background) {
    if (!wantsInput) return;
    for (let i = from; i >= to; i--) {
      if (!paired.has(i) && backgroundItem(input[i]) === background)
        yield* itemHits(input[i], i, 'request', 'input');
    }
  }
  yield* inputs(input.length - 1, recent, false);
  for (const i of paired) yield* itemHits(input[i], i, 'request', 'input');
  if (query.scope !== 'request' && Array.isArray(response?.output)) {
    // The envelope frequently echoes all tool definitions. Visit actual output first.
    for (let i = response.output.length - 1; i >= 0; i--)
      yield* itemHits(response.output[i], i, 'response', 'output');
  } else yield* searchHits(response, 'response', query);
  yield* inputs(recent - 1, 0, false);
  yield* inputs(input.length - 1, 0, true);
  if (query.scope !== 'tool') {
    // Include array-key hits as well as item hits (request:input, response:output).
    if (wantsInput) {
      yield* visit([], ['input'], 'request', query);
      yield* visit(request, [], 'request', query, new Set(['input']));
    }
    if (query.scope !== 'request' && Array.isArray(response?.output)) {
      yield* visit([], ['output'], 'response', query);
      yield* visit(response, [], 'response', query, new Set(['output']));
    }
  }
  for (const [value, path, side] of rawFields) yield* visit(value, path, side, query);
}
