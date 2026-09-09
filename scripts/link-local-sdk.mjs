import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const glimmerRoot = path.resolve(process.argv[2] || process.env.GLIMMER_CRADLE_ROOT || '');
if (!glimmerRoot || !fs.existsSync(path.join(glimmerRoot, 'packages', 'extension-sdk', 'package.json'))) {
  throw new Error('请传入 Glimmer Cradle 主仓库路径，或设置 GLIMMER_CRADLE_ROOT。');
}

const sources = [
  ['contracts', path.join(glimmerRoot, 'contracts')],
  ['extension-sdk', path.join(glimmerRoot, 'packages', 'extension-sdk')],
];
const localScopeRoot = path.join(process.cwd(), 'node_modules', '@glimmer-cradle');
fs.rmSync(path.join(localScopeRoot, 'protocol'), { recursive: true, force: true });

for (const [name, source] of sources) {
  if (!fs.existsSync(path.join(source, 'dist'))) {
    throw new Error(`${name} 尚未构建，请先在主仓库执行 pnpm build:extension-tooling。`);
  }
  const target = path.join(localScopeRoot, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  process.stdout.write(`[local-sdk] @glimmer-cradle/${name} -> ${source}\n`);
}
