import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import YAML from 'yaml';
import { validateExtensionManifest } from '@glimmer-cradle/extension-sdk/manifest';

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const result = validateExtensionManifest(
  YAML.parse(fs.readFileSync(path.join(root, 'extension-manifest.yaml'), 'utf8')),
);
if (!result.ok || !result.data) throw new Error(`Extension manifest 校验失败: ${result.errors.join('; ')}`);

const manifest = result.data;
if (manifest.version !== packageJson.version) {
  throw new Error(`manifest ${manifest.version} 与 package ${packageJson.version} 版本不一致。`);
}
const sdkVersion = packageJson.peerDependencies?.['@glimmer-cradle/extension-sdk'];
if (sdkVersion !== manifest.engines.extensionSdk) {
  throw new Error(`SDK peer ${sdkVersion ?? 'missing'} 与 manifest engine ${manifest.engines.extensionSdk} 不一致。`);
}
if (packageJson.peerDependencies?.['@glimmer-cradle/protocol']) {
  throw new Error('不得依赖已删除的 @glimmer-cradle/protocol。');
}

process.stdout.write(`[manifest] ${manifest.id}@${manifest.version} 使用 Extension SDK ${sdkVersion}。\n`);
