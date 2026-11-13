#!/usr/bin/env node
// ============================================================
// 把工作区基座契约同步进来（三端共用同一份真相源）
// ------------------------------------------------------------
// 为什么是"生成 + 校验"而不是直接跨目录 import：
//   Docker 构建上下文是仓库根，CI 只 checkout 本仓库，
//   上游 `../_base/` 在这两种场景下**不存在**。
//   所以运行期必须有一份仓库内的副本；但副本绝不允许手改 ——
//   它由本脚本生成，头部记录源文件 sha256，--check 会逐字节比对。
//
// 用法：
//   node apps/web/scripts/sync-base-contract.mjs --write    # 有 _base 时重新生成
//   node apps/web/scripts/sync-base-contract.mjs --check    # 校验副本与源一致（CI 用）
// ============================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');            // apps/web
const repoRoot = resolve(webRoot, '../..');     // 仓库根
const target = join(webRoot, 'scripts/realtime/base-contract.mjs');

const MODE = process.argv.includes('--write') ? 'write' : 'check';

function findSource() {
  // 从仓库根往上找 _base/contract/contract.mjs（最多 3 层）
  let dir = repoRoot;
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, '_base', 'contract', 'contract.mjs');
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, '..');
  }
  return null;
}

// 内容指纹对换行归一化：不同平台的 checkout 换行不同，不算内容分叉。
const norm = (text) => text.replace(/\r\n/g, '\n');
const sha = (text) => createHash('sha256').update(norm(text), 'utf8').digest('hex');
const HEADER = (hash) => `// @generated 由 _base/contract/contract.mjs 生成，请勿手改。
// @source-sha256 ${hash}
// @sync node apps/web/scripts/sync-base-contract.mjs --write
// @end-header
`;

function bodyOf(text) {
  // 去掉生成的头部，剩下的部分应与源文件逐字节相同
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('// @')) i++;
  return lines.slice(i).join('\n');
}

const source = findSource();

if (MODE === 'write') {
  if (!source) {
    console.error('✗ 找不到 _base/contract/contract.mjs，无法生成（在 CI 里这是正常的）');
    process.exit(1);
  }
  const src = readFileSync(source, 'utf8');
  writeFileSync(target, HEADER(sha(src)) + src, 'utf8');
  console.log(`✓ 已生成 ${target}`);
  console.log(`  源：${source}`);
  console.log(`  sha256：${sha(src)}`);
  process.exit(0);
}

// ---- check ----
if (!existsSync(target)) {
  console.error('✗ 缺少 apps/web/scripts/realtime/base-contract.mjs');
  process.exit(1);
}
const current = readFileSync(target, 'utf8');
const match = current.match(/^\/\/ @source-sha256 ([0-9a-f]{64})\r?$/m);
if (!match) {
  console.error('✗ 副本缺少 @source-sha256 头，说明它被手改过或不是生成的');
  process.exit(1);
}

if (!source) {
  // CI/独立 checkout：只能做自洽校验
  const selfHash = sha(bodyOf(current));
  if (selfHash !== match[1]) {
    console.error(`✗ 副本内容与自带哈希不符（声明 ${match[1]}，实际 ${selfHash}）—— 文件被改过`);
    process.exit(1);
  }
  console.log('✓ 副本自洽（未找到上游 _base，跳过与源比对）');
  process.exit(0);
}

const srcText = readFileSync(source, 'utf8');
const srcHash = sha(srcText);
if (srcHash !== match[1]) {
  console.error('✗ 基座契约已变更，副本过期');
  console.error(`  上游 sha256：${srcHash}`);
  console.error(`  副本声明  ：${match[1]}`);
  console.error('  修复：node apps/web/scripts/sync-base-contract.mjs --write');
  process.exit(1);
}
if (norm(bodyOf(current)) !== norm(srcText)) {
  console.error('✗ 副本正文与上游不一致（哈希相同但内容不同，说明生成逻辑被破坏）');
  process.exit(1);
}
console.log(`✓ 副本与上游基座契约一致（sha256 ${srcHash.slice(0, 12)}…）`);
