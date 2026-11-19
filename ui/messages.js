// The wire role remains authoritative even when a text block contains role-like markup.
export function compactText(value, limit = 130) {
  const text = String(value ?? '')
    .trim()
    .replace(/\s+/gu, ' ');
  const prefix = [...text.slice(0, limit * 2 + 2)].slice(0, limit).join('');
  return prefix.length < text.length ? prefix + '…' : prefix;
}
export function partPreview(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return JSON.stringify(part);
  if (typeof part.text === 'string') return part.text;
  if (typeof part.thinking === 'string') return part.thinking;
  if (
    part.name &&
    ['tool_use', 'function_call', 'custom_tool_call', 'server_tool_use'].includes(part.type)
  )
    return 'Call ' + part.name;
  if (
    part.type === 'tool_result' ||
    part.type === 'function_call_output' ||
    part.type === 'custom_tool_call_output'
  ) {
    const out = part.output ?? part.content;
    return typeof out === 'string'
      ? out
      : Array.isArray(out) && typeof out[0]?.text === 'string'
        ? out[0].text
        : part.type;
  }
  if (part.type === 'reasoning' && typeof part.summary?.[0]?.text === 'string')
    return part.summary[0].text;
  if (typeof part.refusal === 'string') return part.refusal;
  return (
    { image_url: 'Image', input_audio: 'Audio', file: 'File' }[part.type] || part.type || 'JSON'
  );
}
export function messagePreview(msg) {
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string' && c.trim()) return compactText(c);
  if (Array.isArray(c) && c.length)
    return (c.length > 1 ? c.length + ' blocks · ' : '') + compactText(partPreview(c[0]));
  const names = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((t) => t?.function?.name).filter(Boolean)
    : [];
  if (names?.length) return compactText('Call ' + names.join(', '));
  if (msg.function_call?.name) return compactText('Call ' + msg.function_call.name);
  if (msg.refusal || msg.reasoning_content)
    return compactText(msg.refusal || msg.reasoning_content);
  return c == null ? 'No content' : compactText(JSON.stringify(c));
}
export function pairingWarning(messages) {
  const waiting = new Map();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object' || typeof m.role !== 'string' || !m.role.trim())
      return 'Message ' + (i + 1) + ' is missing a role.';
    if (m.role === 'tool') {
      if (!waiting.has(m.tool_call_id))
        return 'Message ' + (i + 1) + ' has no matching tool call for its tool_call_id.';
      waiting.delete(m.tool_call_id);
    } else if (waiting.size) break;
    if (m.tool_calls != null && !Array.isArray(m.tool_calls))
      return 'Message ' + (i + 1) + ' must have a tool_calls array.';
    for (const t of m.tool_calls || []) {
      if (!t?.id || waiting.has(t.id))
        return 'Message ' + (i + 1) + ' has a missing or duplicate tool call ID.';
      waiting.set(t.id, i + 1);
    }
  }
  if (waiting.size)
    return 'Message ' + waiting.values().next().value + ' is missing a matching tool result.';
  return '';
}
export function addPart(msg, index, part) {
  const parts = Array.isArray(msg.content)
    ? msg.content
    : typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : msg.content == null
        ? []
        : [msg.content];
  parts.splice(index, 0, part);
  msg.content = parts;
}

// Only decode complete layers. Literal paths, regular expressions and incomplete
// escape sequences stay readable in their original form.
export function presentation(value, layers) {
  let text = value;
  for (let depth = 0; depth < 4; depth++) {
    const s = text.trim();
    try {
      if (/^[{\["]/.test(s)) {
        const parsed = JSON.parse(s);
        if (typeof parsed === 'string') {
          layers?.push({ source: text, decoded: parsed, quoted: true });
          text = parsed;
          continue;
        }
        if (parsed && typeof parsed === 'object') return { data: parsed };
      }
    } catch {}
    if (!/\\(?:["nrt]|u[\da-fA-F]{4})/.test(text) || /(?:^|\s)[a-z]:\\/i.test(text)) break;
    try {
      const literal = text.replace(/\\(?:["\\/bfnrt]|u[\da-fA-F]{4})|["\n\r\t]/g, (token) =>
        token.startsWith('\\') ? token : JSON.stringify(token).slice(1, -1),
      );
      const decoded = JSON.parse('"' + literal + '"');
      if (decoded === text) break;
      layers?.push({ source: text, decoded, quoted: false });
      text = decoded;
    } catch {
      break;
    }
  }
  return { text };
}

// Map the changed span back into the original spelling. Unedited escape sequences,
// JSON number literals and whitespace outside that span remain byte-for-byte intact.
function mapEdit(source, display, edited, offset, encode = (s) => s) {
  if (display === edited) return source;
  let start = 0,
    end = display.length,
    nextEnd = edited.length;
  while (start < end && start < nextEnd && display[start] === edited[start]) start++;
  while (end > start && nextEnd > start && display[end - 1] === edited[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  return (
    source.slice(0, offset(start)) +
    encode(edited.slice(start, nextEnd)) +
    source.slice(offset(end))
  );
}
function encodeLayer({ source, decoded, quoted }, edited) {
  const begin = quoted ? source.length - source.trimStart().length + 1 : 0;
  function offset(index) {
    let pos = begin;
    for (let i = 0; i < index; i++, pos++) {
      if (source[pos] === '\\') pos += source[pos + 1] === 'u' ? 5 : 1;
    }
    return pos;
  }
  return mapEdit(source, decoded, edited, offset, (s) => JSON.stringify(s).slice(1, -1));
}
function formattedJson(source) {
  // Format tokens directly. Parsing and re-stringifying would round large integers
  // and merge duplicate keys in a captured payload.
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/g;
  const spans = [];
  let text = '',
    previous = '',
    depth = 0;
  for (const { 0: token, index } of source.matchAll(tokens)) {
    const closing = token === '}' || token === ']';
    const afterOpen = previous === '{' || previous === '[';
    if (closing) depth--;
    if ((closing && !afterOpen) || (!closing && afterOpen) || previous === ',')
      text += '\n' + '  '.repeat(Math.min(depth, 64));
    else if (previous === ':') text += ' ';
    spans.push({ start: text.length, raw: index, length: token.length });
    text += token;
    if (token === '{' || token === '[') depth++;
    previous = token;
  }
  function offset(index) {
    let low = 0,
      high = spans.length;
    while (high - low > 1) {
      const mid = (low + high) >>> 1;
      if (spans[mid].start <= index) low = mid;
      else high = mid;
    }
    const span = spans[low];
    return Math.min(span.raw + index - span.start, spans[low + 1]?.raw ?? span.raw + span.length);
  }
  return { text, encode: (edited) => mapEdit(source, text, edited, offset) };
}
export function prettyEditorText(original) {
  const layers = [];
  const shown = presentation(original, layers);
  const json = shown.data !== undefined ? formattedJson(layers.at(-1)?.decoded ?? original) : null;
  const display = json?.text ?? shown.text;
  const text = display.replace(/\r\n?/g, '\n');
  function restoreLines(edited) {
    if (display === text) return edited;
    const offset = (index) => {
      let pos = 0;
      for (let i = 0; i < index; i++, pos++) if (display.startsWith('\r\n', pos)) pos++;
      return pos;
    };
    return mapEdit(display, text, edited, offset, (s) =>
      display.includes('\r\n') ? s.replaceAll('\n', '\r\n') : s,
    );
  }
  return {
    original,
    text,
    encode(edited) {
      let value = restoreLines(edited);
      if (json) value = json.encode(value);
      for (let i = layers.length - 1; i >= 0; i--) value = encodeLayer(layers[i], value);
      return value;
    },
  };
}
