import type { Plugin } from 'vite';
import { createRealtimeApi } from './scripts/realtime/routes.mjs';

/** dev、preview与生产共享同一API实现，实时状态不会进入Vite浏览器bundle。 */
export function serveRealtime(): Plugin {
  const install = (server: any) => {
    const api = createRealtimeApi();
    server.middlewares.use(async (req: any, res: any, next: any) => {
      if (!(await api.handle(req, res))) next();
    });
    server.httpServer?.once('close', () => api.close());
  };
  return { name: 'bms-realtime-api', configureServer: install, configurePreviewServer: install };
}
