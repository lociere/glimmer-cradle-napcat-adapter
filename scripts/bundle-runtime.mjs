import path from 'node:path';
import process from 'node:process';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';

const root = process.cwd();
const result = await build({
  entryPoints: [path.join(root, 'index.ts')],
  outfile: path.join(root, 'dist', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: false,
  metafile: true,
  external: [
    '@glimmer-cradle/extension-sdk',
    '@glimmer-cradle/extension-sdk/*',
  ],
  logLevel: 'info',
});

const bundledZod = Object.keys(result.metafile.inputs).some((input) => /(?:^|[/\\])zod(?:@|[/\\])/.test(input));
if (!bundledZod) {
  throw new Error('运行时 bundle 未包含 zod；.gcex 不能依赖 Host 注入第三方模块。');
}

const output = result.metafile.outputs[path.join('dist', 'index.js').replaceAll('\\', '/')]
  ?? Object.values(result.metafile.outputs)[0];
const allowedBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const unexpectedExternal = output.imports
  .filter((item) => item.external && !allowedBuiltins.has(item.path) && !item.path.startsWith('@glimmer-cradle/extension-sdk'))
  .map((item) => item.path);
if (unexpectedExternal.length > 0) {
  throw new Error(`.gcex 存在未自包含的第三方运行时依赖: ${unexpectedExternal.join(', ')}`);
}
