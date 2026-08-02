// 让 Vite 在 dev + preview 阶段都 serve/读写 项目根 `scenarios/*.json`
//   - GET    /scenarios/list                  -> 列出所有 .json 文件
//   - GET    /scenarios/:filename             -> 读取 JSON
//   - POST   /scenarios/:filename             -> 写入 JSON body
//   - DELETE /scenarios/:filename             -> 删除文件
// 路径防御：resolved filePath 必须仍在 SCENARIOS_DIR 内
// 仅处理 .json 文件
import fs from 'fs';
import path from 'path';
import type { Plugin, Connect } from 'vite';

const SCENARIOS_DIR = path.resolve(__dirname, '../../scenarios');
const PREFIX = '/scenarios/';

function isSafePath(filePath: string): boolean {
  return filePath.startsWith(SCENARIOS_DIR + path.sep);
}

function sendJson(res: any, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function createScenariosMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') {
      return sendJson(res, 403, { error: '仅允许同源访问' });
    }

    const url = decodeURIComponent((req.url || '').split('?')[0]);
    if (!url.startsWith(PREFIX)) return next();

    const rel = url.slice(PREFIX.length);

    // --- /scenarios/list ---
    if (rel === 'list' && req.method === 'GET') {
      if (!fs.existsSync(SCENARIOS_DIR)) {
        return sendJson(res, 200, []);
      }
      try {
        const entries = fs.readdirSync(SCENARIOS_DIR, { withFileTypes: true });
        const list = entries
          .filter((e) => e.isFile() && e.name.endsWith('.json'))
          .map((e) => {
            const full = path.join(SCENARIOS_DIR, e.name);
            const stat = fs.statSync(full);
            return {
              name: e.name,
              savedAt: stat.mtime.toISOString(),
              size: stat.size,
            };
          })
          .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
        return sendJson(res, 200, list);
      } catch (err) {
        return sendJson(res, 500, { error: (err as Error).message });
      }
    }

    // --- /scenarios/:filename ---
    const filePath = path.join(SCENARIOS_DIR, rel);

    // 路径防御
    if (!isSafePath(filePath)) {
      return sendJson(res, 400, { error: '非法的文件路径' });
    }
    // 仅处理 .json
    if (!filePath.endsWith('.json')) {
      return sendJson(res, 400, { error: '只支持 .json 文件' });
    }

    if (req.method === 'GET') {
      if (!fs.existsSync(filePath)) {
        return sendJson(res, 404, { error: '文件不存在' });
      }
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(content);
        return;
      } catch (err) {
        return sendJson(res, 500, { error: (err as Error).message });
      }
    }

    if (req.method === 'POST') {
      if (req.headers['content-length'] && parseInt(req.headers['content-length'], 10) > 10 * 1024 * 1024) {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: 'Request body too large (max 10MB)' }));
        return;
      }
      try {
        if (!fs.existsSync(SCENARIOS_DIR)) {
          fs.mkdirSync(SCENARIOS_DIR, { recursive: true });
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf-8');
            // 至少要能 parse 出 JSON，避免写入无效文件
            JSON.parse(body);
            const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
            try {
              fs.writeFileSync(tempPath, body, { encoding: 'utf-8', mode: 0o600 });
              fs.renameSync(tempPath, filePath);
            } finally {
              if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            }
            return sendJson(res, 200, { ok: true });
          } catch (err) {
            return sendJson(res, 400, { error: (err as Error).message });
          }
        });
        return;
      } catch (err) {
        return sendJson(res, 500, { error: (err as Error).message });
      }
    }

    if (req.method === 'DELETE') {
      if (!fs.existsSync(filePath)) {
        return sendJson(res, 404, { error: '文件不存在' });
      }
      try {
        fs.unlinkSync(filePath);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 500, { error: (err as Error).message });
      }
    }

    return sendJson(res, 405, { error: 'Method Not Allowed' });
  };
}

export function serveScenarios(): Plugin {
  return {
    name: 'serve-scenarios',
    // M1.5 Round 15: 同时挂载 dev + preview server
    // Vite 中 apply:'serve' 实际包含 dev (configureServer) 与 preview (configurePreviewServer) 两条路径，
    // 这里显式声明两者以确保 `pnpm preview` 也能读写 scenarios。
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(createScenariosMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createScenariosMiddleware());
    },
  };
}
