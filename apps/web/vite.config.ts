import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import os from 'node:os';
import { serveBaseElements } from './vite-svg-plugin';
import { serveScenarios } from './vite-scenarios-plugin';

function getLanIp(): string | undefined {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return undefined;
}

// 思路：
//   - `base-elements/` 在项目根（apps/web 的上一级的上一级），Vite 默认 publicDir 不允许指向项目外
//   - dev：用自定义插件 `serveBaseElements` 在 middleware 拦截 `/base-elements/*` 请求
//   - build：package.json 的 build 脚本调用 `copyBaseElementsToDist()` 把 SVG 复制到 dist
//   - 这样 React 组件可以直接 fetch('/base-elements/pv-array.svg')，dev + build 都通
//   - `scenarios/` 同样在项目根，由 `serveScenarios` 在 middleware 中提供 GET/POST/DELETE/list
export default defineConfig({
  plugins: [react(), serveBaseElements(), serveScenarios()],
  server: {
    port: 5173,
    host: true,
    // 固定 WS 目标，LAN 访问时 HMR 断线不再整页刷新丢失状态
    hmr: { host: getLanIp() },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // M3 大屏按路由懒加载；将重型数据/图表库拆出，避免首次打开原理图加载 ECharts。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/echarts/')) return 'vendor-echarts';
          if (id.includes('/pdfjs-dist/')) return 'vendor-pdf';
          if (id.includes('/xlsx/')) return 'vendor-xlsx';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-router-dom/')) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
});
