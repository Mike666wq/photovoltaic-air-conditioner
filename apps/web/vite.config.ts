import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { serveBaseElements } from './vite-svg-plugin';
import { serveScenarios } from './vite-scenarios-plugin';
import { serveRealtime } from './vite-realtime-plugin';

// 思路：
//   - `base-elements/` 在项目根（apps/web 的上一级的上一级），Vite 默认 publicDir 不允许指向项目外
//   - dev：用自定义插件 `serveBaseElements` 在 middleware 拦截 `/base-elements/*` 请求
//   - build：package.json 的 build 脚本调用 `copyBaseElementsToDist()` 把 SVG 复制到 dist
//   - 这样 React 组件可以直接 fetch('/base-elements/pv-array.svg')，dev + build 都通
//   - `scenarios/` 同样在项目根，由 `serveScenarios` 在 middleware 中提供 GET/POST/DELETE/list
export default defineConfig({
  plugins: [react(), serveRealtime(), serveBaseElements(), serveScenarios()],
  server: {
    port: 5173,
    host: true,
    // 让 HMR 沿用页面实际访问的 hostname；localhost 与 LAN 地址均可正常连接。
    hmr: { clientPort: 5173 },
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
