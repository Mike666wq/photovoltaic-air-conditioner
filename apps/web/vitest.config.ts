import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// scripts/realtime由Node原生测试运行器执行，不能同时被Vitest收集。
export default mergeConfig(viteConfig, defineConfig({ test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] } }));
