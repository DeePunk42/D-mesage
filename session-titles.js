import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function sessionGroupTitle(db, row, titleFor) {
  const name = await titleFor(row.agent, row.session);
  if (name) return name;
  const first = db.query(`SELECT last_preview FROM calls
    WHERE agent IS ? AND session=? AND last_role='user' AND last_preview<>'' AND substr(last_preview,1,1)<>'<'
    ORDER BY started,rowid LIMIT 1`).get(row.agent, row.session);
  return first?.last_preview || row.latest.last_preview;
}

function titleIndex(path, apply) {
  let previous, offset = 0, names = new Map(), loading;
  async function refresh() {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      const sameFile = previous?.ino === info.ino && previous.dev === info.dev;
      if (sameFile && previous.size === info.size && previous.mtimeMs === info.mtimeMs) return names;
      const append = sameFile && info.size > previous.size;
      const next = append ? new Map(names) : new Map();
      let start = append ? offset : 0;
      if (start < info.size) {
        const stream = file.createReadStream({ start, end: info.size - 1, autoClose: false });
        let fragments = [];
        for await (const chunk of stream) {
          let cursor = 0;
          for (let end; (end = chunk.indexOf(10, cursor)) !== -1;) {
            fragments.push(chunk.subarray(cursor, end));
            const bytes = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
            fragments = [];
            start += bytes.length + 1;
            cursor = end + 1;
            const line = bytes.toString();
            if (!/"(?:thread_name|customTitle|aiTitle)"/.test(line)) continue;
            try { apply(next, JSON.parse(line)); } catch {}
          }
          if (cursor < chunk.length) fragments.push(chunk.subarray(cursor));
        }
      }
      previous = info;
      offset = start;
      names = next;
      return names;
    } finally {
      await file.close();
    }
  }
  return () => loading ??= refresh().catch(() => new Map()).finally(() => { loading = null; });
}

export function sessionTitles({
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
} = {}) {
  const codex = titleIndex(join(codexHome, 'session_index.jsonl'), (names, row) => {
    if (typeof row.id === 'string' && typeof row.thread_name === 'string')
      names.set(row.id, row.thread_name.trim());
  });
  const projects = join(claudeHome, 'projects');
  const claudeIndexes = new Map();
  let directory, expires = 0;
  async function claudeFiles() {
    const paths = new Map();
    for await (const path of new Bun.Glob('*/*.jsonl').scan({ cwd: projects, onlyFiles: true })) {
      const id = path.split(/[/\\]/).at(-1).slice(0, -6);
      paths.set(id, paths.has(id) ? null : join(projects, path));
    }
    return paths;
  }
  return async function resolve(agent, session) {
    if (agent === 'codex') return (await codex()).get(session);
    if (agent !== 'claude' && agent !== 'claude-code') return;
    if (!directory || Date.now() >= expires) {
      directory = claudeFiles().catch(() => new Map());
      expires = Date.now() + 5000;
    }
    const path = (await directory).get(session);
    if (!path) return;
    if (!claudeIndexes.has(path)) {
      claudeIndexes.set(path, titleIndex(path, (names, row) => {
        if (row.sessionId !== session || row.isSidechain) return;
        if (row.type === 'custom-title' && typeof row.customTitle === 'string')
          names.set('custom', row.customTitle.trim());
        if (row.type === 'ai-title' && typeof row.aiTitle === 'string')
          names.set('auto', row.aiTitle.trim());
      }));
    }
    const names = await claudeIndexes.get(path)();
    return names.get('custom') || names.get('auto');
  };
}
