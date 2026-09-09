import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  buildExtensionReleaseManifest,
  buildGcexPackage,
  verifyGcexPackage,
} from '@glimmer-cradle/extension-sdk/distribution';

const root = process.cwd();
const releaseDir = path.join(root, 'release');
const commit = readCommit();
if (!commit) throw new Error('发布必须来自可追溯的 Git commit。');
const sourceTag = process.env.GITHUB_REF_NAME || readTag();
if (!sourceTag) throw new Error('发布必须由精确 Git tag 触发。');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (sourceTag !== `v${packageVersion}`) {
  throw new Error(`Git tag ${sourceTag} 与扩展版本 v${packageVersion} 不一致。`);
}
const allowDirtyCandidate = process.env.GCEX_ALLOW_DIRTY === '1';
if (!allowDirtyCandidate && readStatus()) {
  throw new Error('发布工作树必须干净；本地 dirty 候选验证需显式设置 GCEX_ALLOW_DIRTY=1。');
}
if (!allowDirtyCandidate && readTagCommit(sourceTag) !== commit) {
  throw new Error(`Git tag ${sourceTag} 必须真实存在并指向当前 commit ${commit}。`);
}

const channel = process.env.GCEX_CHANNEL || 'stable';
const platforms = [...new Set(
  (process.env.GCEX_PLATFORMS || process.env.GCEX_PLATFORM || 'windows-x64')
    .split(',')
    .map((platform) => platform.trim())
    .filter(Boolean),
)];
if (platforms.length === 0) throw new Error('至少需要一个 GCEX 发布平台。');

fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });
const packages = [];
for (const platform of platforms) {
  const built = await buildGcexPackage({
    extensionRoot: root,
    outputDirectory: releaseDir,
    platform,
    sourceRevision: commit,
    sourceTag,
    channel,
  });
  const verified = await verifyGcexPackage(built.packagePath);
  if (verified.archiveSha256 !== built.archiveSha256 || verified.manifest.id !== built.manifest.id) {
    throw new Error(`${built.packageFileName} 未通过独立完整性复核。`);
  }
  if ([...verified.files.keys()].some((file) => /\.test\.(?:js|d\.ts|d\.ts\.map)$/.test(file))) {
    throw new Error(`${built.packageFileName} 包含编译后的测试文件。`);
  }
  packages.push(built);
}

const releaseManifest = await buildExtensionReleaseManifest({
  packages,
  outputDirectory: releaseDir,
  channel,
});
const releaseFiles = [...packages.map((built) => built.packagePath), releaseManifest.manifestPath];
const checksums = releaseFiles
  .map((file) => `${sha256(fs.readFileSync(file))}  ${path.basename(file)}`)
  .join('\n');
fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS'), `${checksums}\n`, 'utf8');

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

function readTagCommit(tag) {
  try {
    return execFileSync('git', ['rev-list', '-n', '1', tag], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readStatus() {
  try {
    return execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
