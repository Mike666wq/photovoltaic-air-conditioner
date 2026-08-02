// Build 后把 SVG 和旧版演示入口复制到 `dist/base-elements/`。
// 普通构建与 Docker 构建必须产出完全相同的 dist。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/web/scripts/copy-svgs.mjs → apps/web/scripts → apps/web → apps → 项目根（base-elements 的父目录）
const ROOT = path.resolve(__dirname, '../../..');
const SVG_DIR = path.join(ROOT, 'base-elements');
const DIST_DIR = path.resolve(__dirname, '../dist/base-elements');  // apps/web/dist/base-elements/

fs.mkdirSync(DIST_DIR, { recursive: true });
const files = fs.readdirSync(SVG_DIR).filter((f) => f.endsWith('.svg'));
files.forEach((f) => {
  fs.copyFileSync(path.join(SVG_DIR, f), path.join(DIST_DIR, f));
});
fs.copyFileSync(path.join(SVG_DIR, 'index.html'), path.join(DIST_DIR, 'index.html'));
console.log(`[copy-svgs] 复制 ${files.length} 个 SVG 和 index.html 到 ${DIST_DIR}`);
