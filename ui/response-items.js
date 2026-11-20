// Display projections of Responses items. Never write these values into a request.
export function toolLabel(call) {
  return [call?.namespace, call?.name || call?.function?.name].filter(Boolean).join('.');
}

export function toolLookup(messages) {
  const calls = new Map();
  for (const message of messages) {
    for (const item of [
      message,
      ...(Array.isArray(message?.content) ? message.content : []),
      ...(Array.isArray(message?.tool_calls) ? message.tool_calls : []),
    ]) {
      const id = item?.call_id || item?.id;
      if (id && (toolLabel(item) || item.type === 'tool_search_call')) calls.set(id, item);
    }
  }
  return calls;
}

const join = (...values) => values.filter(Boolean).join(' · ');
const firstLine = (text) => (typeof text === 'string' ? text.trimStart().split(/\r?\n/, 1)[0] : '');
function parsed(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toolList(tools) {
  const names = [];
  function collect(items, prefix = '') {
    for (const t of Array.isArray(items) ? items : []) {
      const name = toolLabel(t) || t?.type;
      if (Array.isArray(t?.tools)) collect(t.tools, prefix + (name ? name + '.' : ''));
      else if (name) names.push(prefix + name);
    }
  }
  collect(tools);
  return join(
    names.length + (names.length === 1 ? ' tool' : ' tools'),
    names.slice(0, 3).join(', '),
    names.length > 3 && '+' + (names.length - 3),
  );
}

export function phaseLabel(message) {
  if (message?.role !== 'assistant') return '';
  if (message.phase === 'commentary') return 'Progress';
  return message.phase === 'final_answer' ? 'Final answer' : '';
}

function actionLabel(call) {
  const args = parsed(call?.arguments);
  switch (call?.name) {
    case 'exec_command':
      return firstLine(args?.cmd);
    case 'write_stdin':
      return args?.session_id != null ? 'session ' + args.session_id : '';
    case 'view_image':
      return typeof args?.path === 'string' ? args.path.split(/[\\/]/).pop() : '';
    case 'exec': {
      if (typeof call.input !== 'string') return '';
      const refs = [
        ...new Set(Array.from(call.input.matchAll(/\btools\.([\w$]+)\s*\(/g), (m) => m[1])),
      ];
      return refs.length ? 'references ' + refs.join(', ') : '';
    }
    default:
      return '';
  }
}

function shellText(text) {
  // Only recognize metadata in the leading executor envelope. Output can quote the same words.
  const header =
    /^(?:(?:Chunk ID: [^\n]*|Wall time:? [^\n]*|Process exited with code -?\d+|Process running with session ID [^\n]*|Exit code: -?\d+|Original token count: \d+|Script completed|Script running with cell ID [^\n]*)\r?\n)+(?:Final output:|Output:)[^\S\r\n]*(?:\r?\n|$)/i.exec(
      text,
    );
  if (!header) return { text };
  const exit = /^(?:Process exited with code |Exit code: )(-?\d+)/im.exec(header[0]);
  const running = /^(?:Process running with session ID|Script running with cell ID) (\S+)/im.exec(
    header[0],
  );
  return {
    text: text.slice(header[0].length),
    status: exit ? 'exit ' + exit[1] : running ? 'running · ' + running[1] : '',
  };
}

export function resultParts(item, call) {
  const result = [];
  function append(value, depth = 0) {
    if (depth > 5) {
      result.push({ value });
      return;
    }
    if (Array.isArray(value)) {
      for (const part of value) append(part, depth + 1);
      return;
    }
    if (value?.type === 'input_image') {
      result.push({ image: value });
      return;
    }
    if (typeof value?.text === 'string') {
      append(value.text, depth + 1);
      return;
    }
    if (call?.name === 'exec') {
      if (typeof value === 'string' && /^\s*[\[{]/.test(value)) {
        const data = parsed(value);
        if (data && typeof data === 'object') {
          append(data, depth + 1);
          return;
        }
      }
      if (value?.status === 'fulfilled' && 'value' in value) {
        append(value.value, depth + 1);
        return;
      }
      if (value?.status === 'rejected') {
        result.push({ status: 'rejected', value: value.reason });
        return;
      }
      if (
        typeof value?.output === 'string' &&
        ('exit_code' in value || 'session_id' in value || 'chunk_id' in value)
      ) {
        result.push({
          text: value.output,
          status:
            value.exit_code != null
              ? 'exit ' + value.exit_code
              : value.session_id != null
                ? 'running · ' + value.session_id
                : '',
        });
        return;
      }
    }
    if (typeof value === 'string') {
      const known = ['exec', 'exec_command', 'write_stdin', 'apply_patch'].includes(call?.name);
      result.push(known ? shellText(value) : { text: value });
    } else if (value != null) result.push({ value });
  }
  append(item.output);
  return result;
}

export function resultLabel(parts, call) {
  const status = [...new Set(parts.map((p) => p.status).filter(Boolean))];
  status.sort((a, b) => Number(a === 'exit 0') - Number(b === 'exit 0'));
  const images = parts.filter((p) => p.image).length;
  const preferred =
    parts.find(
      (p) => p.status && p.status !== 'exit 0' && (p.text?.trim() || typeof p.value === 'string'),
    ) || parts.find((p) => p.text?.trim());
  let content = firstLine(preferred?.text || preferred?.value);
  if (call?.name === 'apply_patch' && content === 'Success. Updated the following files:') {
    const files = preferred.text
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .filter((s) => /^[AMD] /.test(s));
    if (files.length) content = files.join(', ');
  }
  if (!content && parts.some((p) => p.value != null)) content = 'Structured output';
  return join(status.join(', '), images && images + (images === 1 ? ' image' : ' images'), content);
}

export function itemLabel(item, lookup) {
  switch (item?.type) {
    case 'reasoning':
      return (
        (Array.isArray(item.summary) &&
          item.summary
            .map((s) => s?.text)
            .filter(Boolean)
            .join(' ')) ||
        (item.encrypted_content ? 'Encrypted reasoning' : 'Reasoning')
      );
    case 'additional_tools':
      return join('Tools added', toolList(item.tools));
    case 'compaction_trigger':
      return 'Compaction requested';
    case 'compaction':
      return 'Compaction item';
    case 'configuration_update':
      return 'Configuration updated';
    case 'web_search_call': {
      const a = item.action || {};
      return join(
        'web_search',
        a.type,
        a.query || (Array.isArray(a.queries) && a.queries.join(', ')) || a.pattern,
        a.url,
      );
    }
    case 'tool_search_call':
      return join('tool_search', parsed(item.arguments)?.query);
    case 'tool_search_output':
      return join('Tool search results', toolList(item.tools));
    case 'function_call':
    case 'custom_tool_call':
      return join(toolLabel(item) || item.type, actionLabel(item));
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const call = lookup?.get(item.call_id);
      const result = resultLabel(resultParts(item, call), call);
      // Keep the outcome within a short list preview even for very long commands.
      const action = actionLabel(call);
      return join(
        toolLabel(call) || 'Tool result',
        action.length > 48 ? action.slice(0, 47) + '…' : action,
        result,
      );
    }
    default:
      return '';
  }
}

export function finalPreview(reply) {
  const final =
    Array.isArray(reply?.output) && reply.output.findLast((m) => phaseLabel(m) === 'Final answer');
  if (!final) return null;
  const content = Array.isArray(final.content)
    ? final.content
        .map((p) => p?.text || p?.refusal)
        .filter(Boolean)
        .join(' ')
    : final.content;
  return typeof content === 'string' ? content.trim().slice(0, 180).replace(/\s+/g, ' ') : '';
}
