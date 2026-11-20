// Pure helpers: no storage access, so tests can import them safely.
// Fields a client rewrites between turns without changing the conversation.
const VOLATILE = {
  responses: new Set(['id', 'status', 'metadata', 'internal_chat_message_metadata_passthrough']),
  anthropic: new Set(['cache_control']),
  chat: new Set(['cache_control']),
};

function clean(value, drop) {
  if (Array.isArray(value)) {
    const items = value.map((item) => clean(item, drop)).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (drop.has(key)) continue;
      const item = clean(value[key], drop);
      if (item !== undefined) out[key] = item;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value === null || value === '' ? undefined : value;
}

const blocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : content);

function conversation(protocol, body) {
  if (protocol === 'responses') {
    const input =
      typeof body?.input === 'string'
        ? [{ role: 'user', content: body.input }]
        : Array.isArray(body?.input)
          ? body.input
          : [];
    return { head: { instructions: body?.instructions, tools: body?.tools }, items: input };
  }
  if (protocol === 'anthropic') {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    return {
      head: { system: blocks(body.system), tools: body.tools },
      items: messages.map((m) => (m && typeof m === 'object' ? { ...m, content: blocks(m.content) } : m)),
    };
  }
  if (protocol === 'chat') {
    return { head: { tools: body?.tools }, items: Array.isArray(body?.messages) ? body.messages : [] };
  }
  return null;
}

// chain[0] identifies the system prompt and tools; chain[i] the first i conversation items.
// Items are chained independently of chain[0], so a model or tool change keeps the line.
export function requestChain(protocol, body) {
  const parts = conversation(protocol, body);
  if (!parts) return null;
  const drop = VOLATILE[protocol];
  const chain = new BigUint64Array(parts.items.length + 1);
  chain[0] = BigInt(Bun.hash(JSON.stringify(clean(parts.head, drop) ?? null)));
  const start = BigInt(Bun.hash(protocol));
  parts.items.forEach((item, i) => {
    chain[i + 1] = BigInt(Bun.hash(JSON.stringify(clean(item, drop) ?? null), i ? chain[i] : start));
  });
  return chain;
}

// Pure tree inference over prefix chains, in capture order.
export function buildShape(chains) {
  const prefixOwner = new Map(),
    fullOwner = new Map();
  const nodes = chains.map((chain) => ({ items: Math.max(0, chain.length - 1), children: 0 }));
  chains.forEach((chain, i) => {
    const node = nodes[i],
      last = chain.length - 1;
    node.parent = null;
    node.kept = 0;
    node.kind = 'root';
    let shared = 0;
    if (last >= 1 && prefixOwner.has(chain[1])) {
      let low = 1,
        high = last;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (prefixOwner.has(chain[mid])) low = mid;
        else high = mid - 1;
      }
      shared = low;
    }
    if (shared > 0) {
      // Prefer the newest earlier request that this one extends; otherwise it rewrote history.
      let ancestor = shared;
      while (ancestor > 0 && !fullOwner.has(chain[ancestor])) ancestor--;
      if (ancestor > 0) {
        node.parent = fullOwner.get(chain[ancestor]);
        node.kept = ancestor;
        node.kind = ancestor === last ? 'retry' : 'turn';
      } else {
        node.parent = prefixOwner.get(chain[shared]);
        node.kept = shared;
        node.kind = 2 * shared < nodes[node.parent].items ? 'compacted' : 'branch';
      }
      nodes[node.parent].children++;
      node.headChanged = chains[node.parent][0] !== chain[0];
    }
    node.added = node.items - node.kept;
    for (let j = 1; j <= last; j++) prefixOwner.set(chain[j], i);
    if (last >= 1) fullOwner.set(chain[last], i);
  });
  markMainline(nodes);
  return nodes;
}

function markMainline(nodes) {
  const size = nodes.map(() => 1),
    kids = nodes.map(() => []);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const parent = nodes[i].parent;
    if (parent != null) {
      size[parent] += size[i];
      kids[parent].push(i);
    }
  }
  // Largest subtree wins; ties go to the earliest root and to the newest child.
  const pick = (list, newest) =>
    list.reduce(
      (best, i) =>
        best == null ||
        size[i] > size[best] ||
        (size[i] === size[best] && (newest ? i > best : i < best))
          ? i
          : best,
      null,
    );
  let cursor = pick(
    nodes.map((n, i) => (n.parent == null ? i : null)).filter((i) => i != null),
    false,
  );
  while (cursor != null) {
    nodes[cursor].main = true;
    cursor = pick(kids[cursor], true);
  }
  for (const node of nodes) {
    node.main = !!node.main;
    node.side = !node.main && node.children === 0 && node.parent != null && nodes[node.parent].main;
  }
}
