import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildGcexPackage } from '@glimmer-cradle/extension-sdk/distribution';

const root = process.cwd();
const releaseDir = path.join(root, 'release');
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });
const commit = readCommit();
if (!commit) throw new Error('发布必须来自可追溯的 Git commit。');

await buildGcexPackage({
  extensionRoot: root,
  outputDirectory: releaseDir,
  platform: process.env.GCEX_PLATFORM || 'windows-x64',
  sourceRevision: commit,
  sourceTag: process.env.GITHUB_REF_NAME || readTag(),
  channel: process.env.GCEX_CHANNEL || 'stable',
});

function readCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function readTag() {
  try {
    return execFileSync('git', ['describe', '--tags', '--exact-match'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}
