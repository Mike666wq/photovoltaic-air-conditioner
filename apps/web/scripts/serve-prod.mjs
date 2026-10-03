import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRealtimeApi } from './realtime/routes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '../dist');
// 默认相对项目根；Docker 容器内通过 SCENARIOS_DIR 环境变量覆盖（/app/scenarios）
const SCENARIOS_DIR = process.env.SCENARIOS_DIR
  ? path.resolve(process.env.SCENARIOS_DIR)
  : path.resolve(__dirname, '../../../scenarios');
const PORT = process.env.PORT ? Number(process.env.PORT) : 80;
const HOST = process.env.HOST || '0.0.0.0';
const PREFIX = '/scenarios/';
const MAX_BODY = 10 * 1024 * 1024; // 10MB

// MIME 类型（含 SVG、JS、CSS、HTML、JSON 等）
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function isSafePath(filePath) {
  return filePath.startsWith(SCENARIOS_DIR + path.sep);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function safeDecode(input) {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

// --- 静态文件服务（含 SPA fallback 到 index.html）---
function serveStatic(req, res) {
  const urlPath = safeDecode((req.url || '').split('?')[0]);
  let filePath = path.join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath);

  // 路径穿越防御
  if (!filePath.startsWith(DIST_DIR + path.sep) && filePath !== path.join(DIST_DIR, 'index.html')) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    // 目录请求遵循常见 Web 服务器规则：优先读取该目录下的 index.html。
    if (urlPath !== '/' && !urlPath.endsWith('/')) {
      res.statusCode = 301;
      res.setHeader('Location', `${urlPath}/`);
      res.end();
      return;
    }
    const directoryIndex = path.join(filePath, 'index.html');
    if (fs.existsSync(directoryIndex) && fs.statSync(directoryIndex).isFile()) {
      filePath = directoryIndex;
    } else {
      filePath = path.join(DIST_DIR, 'index.html');
    }
  } else if (!fs.existsSync(filePath)) {
    // 不存在的路径才走 SPA fallback。
    filePath = path.join(DIST_DIR, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=86400');
  fs.createReadStream(filePath).pipe(res);
}

// --- scenarios CRUD 处理 ---
function handleScenarios(req, res) {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 403, { error: '仅允许同源访问' });
  }

  const url = safeDecode((req.url || '').split('?')[0]);
  const rel = url.slice(PREFIX.length);

  // --- /scenarios/list ---
  if (rel === 'list' && req.method === 'GET') {
    if (!fs.existsSync(SCENARIOS_DIR)) return sendJson(res, 200, []);
    try {
      const entries = fs.readdirSync(SCENARIOS_DIR, { withFileTypes: true });
      const list = entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => {
          const full = path.join(SCENARIOS_DIR, e.name);
          const stat = fs.statSync(full);
          return { name: e.name, savedAt: stat.mtime.toISOString(), size: stat.size };
        })
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      return sendJson(res, 200, list);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  const filePath = path.join(SCENARIOS_DIR, rel);
  if (!isSafePath(filePath)) return sendJson(res, 400, { error: '非法的文件路径' });
  if (!filePath.endsWith('.json')) return sendJson(res, 400, { error: '只支持 .json 文件' });

  if (req.method === 'GET') {
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: '文件不存在' });
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(content);
      return;
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST') {
    if (req.headers['content-length'] && parseInt(req.headers['content-length'], 10) > MAX_BODY) {
      return sendJson(res, 413, { error: 'Request body too large (max 10MB)' });
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        aborted = true;
        sendJson(res, 413, { error: 'Request body too large (max 10MB)' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        if (!fs.existsSync(SCENARIOS_DIR)) fs.mkdirSync(SCENARIOS_DIR, { recursive: true });
        const body = Buffer.concat(chunks).toString('utf-8');
        JSON.parse(body);
        // 同目录临时文件 + rename，保证备份和读取不会看到半写入 JSON。
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        try {
          fs.writeFileSync(tempPath, body, { encoding: 'utf-8', mode: 0o600 });
          fs.renameSync(tempPath, filePath);
        } finally {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (req.method === 'DELETE') {
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: '文件不存在' });
    try {
      fs.unlinkSync(filePath);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  return sendJson(res, 405, { error: 'Method Not Allowed' });
}

const realtime = createRealtimeApi();
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  if (await realtime.handle(req, res)) return;
  if (url === '/health') {
    res.statusCode = 200;
    res.end('ok');
    return;
  }
  if (url.startsWith(PREFIX)) {
    handleScenarios(req, res);
  } else {
    serveStatic(req, res);
  }
});
server.on('close', () => realtime.close());

server.listen(PORT, HOST, () => {
  console.log(`[pv-ac-sim] 生产服务器已启动: http://${HOST}:${PORT}`);
  console.log(`[pv-ac-sim] 静态目录: ${DIST_DIR}`);
  console.log(`[pv-ac-sim] 场景目录: ${SCENARIOS_DIR}`);
});
