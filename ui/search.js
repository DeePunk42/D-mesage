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
    /^(?:tool_use|tool_result|server_tool_use|(?:\w+_)?call(?:_output)?|\w+_tool_result)$/.test(
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

export function* searchHits(body, side, query) {
  if (!query.needle || body == null || !['all', 'tool', side].includes(query.scope)) return;
  function* visit(value, path) {
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
      for (const [index, child] of value.entries()) yield* visit(child, [...path, index]);
    } else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) yield* visit(value[key], [...path, key]);
    }
  }
  for (const [value, path] of query.scope === 'tool' ? toolRoots(body) : [[body, []]])
    yield* visit(value, path);
}
