import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dataDir } from './store.js';

const dir = dirname(fileURLToPath(import.meta.url));
const cli = Bun.which('magpie') || '/Applications/magpie.app/Contents/MacOS/magpie';
if (!existsSync(cli)) throw Error('找不到 Magpie CLI。');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const keyFile = join(dataDir, 'page.key');
if (!existsSync(keyFile))
  writeFileSync(keyFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
const uiKey = readFileSync(keyFile, 'utf8').trim();
const port = 34891;
function run(args) {
  const p = spawnSync(cli, ['plugin', ...args], { encoding: 'utf8' });
  if (p.status !== 0)
    throw Error((p.stderr || p.stdout || '插件安装失败').replaceAll(uiKey, '[redacted]'));
}
run(['add', dir]);
run(['options', dir, JSON.stringify({ uiKey, port, pageHostPort: port })]);
console.log('已安装 D-message。请从 Magpie 的 Plugins 侧栏打开。');
