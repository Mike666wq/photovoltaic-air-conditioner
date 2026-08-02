// 让 Vite 在 dev / build 阶段都能 serve 项目根 `base-elements/*.svg`
// 原因：Vite 默认 `publicDir` 不允许指向项目外；server middleware 拦截最简单。
// 注意：connect middleware 的 prefix 路由**不会**从 req.url 中去掉前缀，
//      所以 handler 里要自己 slice。
import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';

const SVG_DIR = path.resolve(__dirname, '../../base-elements');
const PREFIX = '/base-elements/';

export function serveBaseElements(): Plugin {
  return {
    name: 'serve-base-elements',
    apply: 'serve', // 只在 dev 跑，build 阶段由 closeBundle 处理复制
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url || '').split('?')[0]);
        if (url.startsWith(PREFIX)) {
          const rel = url.slice(PREFIX.length);
          const filePath = path.join(SVG_DIR, rel);
          // 防御：确保仍在 SVG_DIR 内
          if (
            filePath.startsWith(SVG_DIR) &&
            fs.existsSync(filePath) &&
            filePath.endsWith('.svg')
          ) {
            const content = fs.readFileSync(filePath, 'utf-8');
            res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(content);
            return;
          }
        }
        next();
      });
    },
  };
}

// build 阶段单独导出（不用 plugin，因为 Vite 5 plugin hook 在 build 模式行为不同）
export function copyBaseElementsToDist(): void {
  const distDir = path.resolve(__dirname, 'dist/base-elements');
  fs.mkdirSync(distDir, { recursive: true });
  const files = fs.readdirSync(SVG_DIR).filter((f) => f.endsWith('.svg'));
  files.forEach((f) => {
    fs.copyFileSync(path.join(SVG_DIR, f), path.join(distDir, f));
  });
  console.log(`[copy-base-elements] 复制 ${files.length} 个 SVG 到 dist/base-elements/`);
}