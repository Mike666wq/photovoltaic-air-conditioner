# 本地压缩包 + 线上 Docker 镜像构建

> ⚠️ **本文档为 M1.5 之前的"手工作坊"部署流程归档。**
>
> 当前项目已升级到 CICD 流程，详见：
> - [`CICD持续集成部署.md`](../CICD持续集成部署.md)（顶层总览）
> - [`README.md`](./README.md)（日常运维手册）
>
> 此文档保留仅作历史参考，**请勿再按此流程操作**。

---

> 适用场景（原）：将当前项目（`apps/web/` Vite + React 18 主页面 + `base-elements/index.html` 旧版演示）从本地打包成压缩包，上传到服务器后在服务器上构建并运行 Docker 镜像。两套页面通过 URL 路径区分，共用一份 SVG 资源。

---

## 流程总览

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  本地：   │    │  上传：   │    │  服务器： │    │  服务器： │
│ 打包源码  │───▶│ scp/其他 │───▶│ 解压+写   │───▶│ docker   │
│  tar.gz  │    │ 传输     │    │ Dockerfile│    │ build/run│
└──────────┘    └──────────┘    └──────────┘    └──────────┘
```

---

## 0. 关于 nginx 的决策

**本项目不需要 nginx。** 直接用 `busybox:stable` 内置的 `httpd` 命令提供静态文件服务。

| 维度 | nginx:alpine | busybox:stable（采用） |
|---|---|---|
| 镜像大小 | 40MB | **5MB** |
| 配置文件 | 需要 nginx.conf | **零配置** |
| 资源路径 `/base-elements/*.svg` | 需 `charset utf-8` | **天然支持** |
| 缓存控制 | 灵活 | 无（反正小） |
| gzip 压缩 | 支持 | 不支持 |
| 镜像拉取速度 | 慢 | **秒级** |
| 适合纯静态 SPA | 杀鸡用牛刀 | **刚好够用** |

理由：本项目是无后端的纯静态 SPA，无路由、无 gzip 需求、低流量，`busybox httpd` 完全够用。

---

## 1. 项目结构精细化分析

### 1.1 当前项目实际结构（与本部署相关的部分）

```
photovoltaic-air-conditioner/
├─ apps/web/                          【必须打包】
│  ├─ package.json                    依赖清单
│  ├─ vite.config.ts                  构建配置
│  ├─ vite-svg-plugin.ts              SVG 中间件（build 阶段需要）
│  ├─ tsconfig.json                   TS 配置
│  ├─ tsconfig.app.json
│  ├─ tsconfig.node.json
│  ├─ index.html                      入口 HTML
│  ├─ scripts/copy-svgs.mjs           build 后复制 SVG 到 dist
│  └─ src/                            React 源码（全部）
│     ├─ main.tsx
│     ├─ App.tsx
│     ├─ styles.css
│     ├─ components/   (14 个文件：CircuitCanvas/ControlPanel/TopBar/PalettePanel/LogPanel/Tooltip/GridPattern/CableControlItem/CableControlDetail/ComponentDetail/ImportDataDialog/SaveManager/ToastContainer/TsPointer)
│     ├─ injector/injector.ts
│     ├─ store/simulation.ts
│     ├─ store/toast.ts
│     ├─ data/          (7 个文件：components/cables/anchors/palettes/meters/presets/saveSchema)
│     ├─ services/      (5 个文件：dataMapper/injectionParser/pdfFieldMap/scenarioStorage/stateSerializer)
│     ├─ engine/pcm.ts
│     └─ hooks/useParticleAnimation.ts
├─ base-elements/                     【必须打包】英文资源目录（原 基础元件（旧中文名），已重命名）
│  ├─ *.svg   (17 个部件/线缆 SVG)
│  └─ index.html                      旧版单文件演示（已从 demo.html 重命名，相对路径加载 SVG）
├─ package.json                       【必须打包】workspace 配置
├─ pnpm-lock.yaml                     【必须打包】依赖锁文件
└─ pnpm-workspace.yaml                【必须打包】workspace 配置
```

### 1.2 不打包的清单（精细）

| 路径 | 不打包原因 | 节省体积 |
|---|---|---|
| `node_modules/` | 运行时镜像装，pnpm 会装 | ~100MB |
| `apps/web/node_modules/` | 同上 | ~50MB |
| `apps/web/dist/` | 构建产物，不入源码 | ~500KB |
| `apps/web/tsconfig.tsbuildinfo` | 增量编译缓存 | ~50KB |
| `apps/web/README.md` | 文档 | ~2KB |
| `apps/web/public/` | 空目录 | 0 |
| `apps/web/.DS_Store` | macOS 缓存 | ~10KB |
| `base-elements/injector.ts` | TS 版在 apps/web 里，此处是 demo 用的 | ~10KB |
| `base-elements/README.md` | 文档 | ~5KB |
| `base-elements/数据字段映射.md` | 文档 | ~5KB |
| `base-elements/.DS_Store` | macOS 缓存 | ~10KB |
| `data/` (pdf/xlsx/jpg) | 实验数据，不参与构建 | 几 MB |
| `.git/` | Git 元数据 | 几 MB |
| `.mimocode/` | 编辑器缓存 | 几 MB |
| 所有根目录 `*.md` | 文档（AGENTS.md/部件动画增强.md/电路实现逻辑.md/...） | ~150KB |
| `.DS_Store` / `.vscode` / `.idea` | 系统/编辑器临时文件 | 极小 |

### 1.3 打包后预期体积

源码 **< 2MB**。

---

## 2. 本地：精细化打包命令

```bash
cd /Users/bbben/Desktop/photovoltaic-air-conditioner

gtar \
  --exclude='./node_modules' \
  --exclude='./.git' \
  --exclude='./.gitignore' \
  --exclude='./.mimocode' \
  --exclude='./apps/web/node_modules' \
  --exclude='./apps/web/dist' \
  --exclude='./apps/web/tsconfig.tsbuildinfo' \
  --exclude='./apps/web/README.md' \
  --exclude='./apps/web/public' \
  --exclude='./apps/web/.DS_Store' \
  --exclude='./base-elements/injector.ts' \
  --exclude='./scenarios' \
  --exclude='./base-elements/README.md' \
  --exclude='./base-elements/数据字段映射.md' \
  --exclude='./base-elements/.DS_Store' \
  --exclude='./data' \
  --exclude='./.DS_Store' \
  --exclude='./.vscode' \
  --exclude='./.idea' \
  --exclude='./*.md' \
  --exclude='./apps/**/*.md' \
  --transform 's,^./,pv-ac-sim-src/,' \
  -czf pv-ac-sim-src.tar.gz \
  .
```

### 验证打包结果

```bash
ls -lh pv-ac-sim-src.tar.gz
tar -tzf pv-ac-sim-src.tar.gz | sort
```

**预期看到**（示例）：
```
pv-ac-sim-src/apps/web/index.html
pv-ac-sim-src/apps/web/package.json
pv-ac-sim-src/apps/web/src/...
pv-ac-sim-src/apps/web/scripts/copy-svgs.mjs
pv-ac-sim-src/apps/web/vite.config.ts
pv-ac-sim-src/apps/web/vite-svg-plugin.ts
pv-ac-sim-src/apps/web/tsconfig.json
pv-ac-sim-src/apps/web/tsconfig.app.json
pv-ac-sim-src/apps/web/tsconfig.node.json
pv-ac-sim-src/base-elements/air-terminal.svg
pv-ac-sim-src/base-elements/battery.svg
pv-ac-sim-src/base-elements/index.html
... (共 17 个 svg)
pv-ac-sim-src/package.json
pv-ac-sim-src/pnpm-lock.yaml
pv-ac-sim-src/pnpm-workspace.yaml
```

**不应包含**：任何 `.md`、任何 `node_modules`、任何 `data/`、任何 `.git/`。

---

## 3. 上传到服务器 + 解压

```bash
# 本地
scp pv-ac-sim-src.tar.gz user@<server-ip>:/opt/

# 服务器
ssh user@<server-ip>
cd /opt
tar -xzf pv-ac-sim-src.tar.gz
cd pv-ac-sim-src
ls    # 看到 apps/、base-elements/、package.json 等
```

---

## 4. 服务器上写 Dockerfile（核心，最重要）

### 4.1 基础镜像选择（两阶段）

| 阶段 | 基础镜像 | 大小 | 作用 |
|---|---|---|---|
| 阶段 1（builder） | **`node:20-alpine`** | ~180MB | 装 pnpm + 跑 vite build |
| 阶段 2（runtime） | **`busybox:stable`** | **~5MB** | 内置 httpd 提供静态服务 |

**为什么 builder 用 node:20-alpine**：
- `node:20`：固定 Node 版本，避免 latest 漂移导致构建不稳定
- `alpine`：基于 musl libc，镜像更小（vs slim 250MB）
- 包含 npm/yarn，corepack 可激活 pnpm

**为什么 runtime 用 busybox:stable**：
- 内置 httpd 命令（AC httpd 精简版），一行 CMD 启动
- 5MB 镜像，nginx 是 40MB
- 资源路径天然支持（URL 解码后直接走文件系统）
- 无需任何配置文件

**为什么用两个镜像（多阶段）**：构建前端需要 Node + pnpm（180MB），运行时只需要静态文件服务器（5MB）。多阶段构建把"构建工具"和"运行时"分离，让最终镜像只剩 5MB。

### 4.2 在服务器上创建 Dockerfile

```bash
cd /opt/pv-ac-sim-src
vi Dockerfile
```

### 4.3 Dockerfile 完整内容（粘贴到 vi）

```dockerfile
# ===== 阶段 1：构建前端 =====
FROM node:20-alpine AS builder
WORKDIR /build

# 启用 pnpm 9（与项目 packageManager 字段一致）
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# 先拷 lockfile 走 Docker 缓存层（代码改了不重装依赖）
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/

# 装依赖（冻结 lockfile，确保环境一致）
RUN pnpm install --frozen-lockfile

# 再拷源码
COPY base-elements ./base-elements
COPY apps/web ./apps/web

# 跑构建（产物在 apps/web/dist，含 copy-svgs.mjs 复制 SVG）
RUN pnpm --filter web build

# ⚠️ 关键：手动把 index.html 放进 dist/base-elements/
#   Vite 不会构建它（不在 React 入口图里），必须显式 COPY 到与 SVG 同目录
#   这样 index.html 内的相对路径 ./xxx.svg 才能找到对应 SVG
COPY base-elements/index.html ./apps/web/dist/base-elements/index.html

# ===== 阶段 2：运行静态文件 =====
FROM busybox:stable
LABEL maintainer="pv-ac-sim"

# 从 builder 阶段复制构建产物到 /public
COPY --from=builder /build/apps/web/dist /public

# 暴露端口：仅 80（HTTP，无 HTTPS）
EXPOSE 80

# 启动 busybox 内置 httpd
# -f 前台运行  -p 80 监听端口  -h /public 静态文件根目录
CMD ["httpd", "-f", "-p", "80", "-h", "/public"]
```

### 4.4 EXPOSE 端口说明

- **80**：HTTP 标准端口，浏览器访问用
- **不需要 443**：本项目无 HTTPS
- **不需要其他端口**：无后端 API、无数据库

`EXPOSE 80` 只是元数据声明，实际端口映射由 `docker run -p <host>:<container>` 决定。

### 4.5 CMD 解析

- `httpd` —— busybox 自带的静态文件服务器
- `-f` —— 前台运行（Docker 容器需要前台进程，否则容器立即退出）
- `-p 80` —— 监听 80 端口
- `-h /public` —— 静态文件根目录（即 `apps/web/dist/` 复制到这里）

### 4.6 两个页面的访问方式（单端口 + 路径区分）

容器内 `/public/` 目录结构：

```
/public/
├── index.html                ← React App 入口
├── assets/
│   ├── index-xxx.js
│   └── index-xxx.css
└── base-elements/
    ├── index.html            ← 旧版单文件演示（由 demo.html 重命名）
    ├── pv-array.svg          ← 两个页面共用
    └── ... (17 个 SVG)
```

浏览器访问：

| 页面 | URL（推荐） | URL（也支持） | 容器内返回 |
|---|---|---|---|
| **React App（M1 主页面）** | `http://服务器IP:8080/` | — | `/public/index.html` |
| **旧版演示** | `http://服务器IP:8080/base-elements/index.html` | `http://服务器IP:8080/base-elements/` | `/public/base-elements/index.html` |

> **双 URL 支持**：busybox httpd 默认在访问目录时会优先返回目录内的 `index.html`，因此 `/base-elements/` 与 `/base-elements/index.html` 都可访问到同一文件。推荐用后者（明确、URL 短）。

**为什么单端口即可**：两个页面共享同一份 SVG 文件（`/public/base-elements/*.svg`），本质是同一项目的两个入口，不需要拆成两个服务。busybox httpd 原生按 URL 路径返回文件，无需额外路由配置。

**为什么 index.html 放在 `/public/base-elements/` 下**：index.html 内部用 `fetch('./xxx.svg')` 相对路径加载 SVG，必须与 SVG 同目录。放根目录则相对路径失效。

### 4.7 关于不需要挂载本地目录

本项目是**纯静态网站**，没有需要持久化的数据：

- ✅ 没有数据库
- ✅ 没有用户上传文件
- ✅ 没有运行时生成的日志需要持久化
- ✅ 镜像本身就是不可变的，所有内容都在镜像层

**所以 `-v` 挂载完全不需要**，`docker run` 命令非常简洁。

---

## 5. 服务器：构建 + 运行

### 5.1 构建镜像

```bash
# 仍在 pv-ac-sim-src 目录下
docker build -t pv-ac-sim:latest .
```

构建过程约 2-5 分钟（取决于网络），日志会显示：
- `[builder 阶段]` pnpm install → vite build
- `[runtime 阶段]` 复制 dist 到 busybox 镜像

### 5.2 查看镜像

```bash
docker images pv-ac-sim
```

预期输出（镜像约 185MB）：
```
REPOSITORY    TAG       IMAGE ID       CREATED          SIZE
pv-ac-sim     latest    xxxxxxxxxxxx   10 seconds ago   185MB
```

（看起来 185MB 较大，是因为 builder 阶段（180MB）+ runtime 阶段（5MB）都在；最终运行的容器只用 runtime 那 5MB。）

### 5.3 运行容器

```bash
docker run -d \
  --name pv-ac-sim \
  -p 8080:80 \
  --restart unless-stopped \
  pv-ac-sim:latest
```

**参数解析**：

| 参数 | 含义 |
|---|---|
| `-d` | 后台运行 |
| `--name pv-ac-sim` | 容器命名 |
| `-p 8080:80` | 宿主机 8080 端口 → 容器 80 端口 |
| `--restart unless-stopped` | 开机自启（服务器重启后自动恢复） |

宿主机端口 8080 可按需修改（如改为 80 直接对外开放，但要注意防火墙）。

---

## 6. 验证

### 6.1 容器状态

```bash
docker ps
```

应看到 `pv-ac-sim` 状态 `Up`。

### 6.1.1 关键文件存在性（最先验证，省时间）

```bash
# React App 入口
docker exec pv-ac-sim ls /public/index.html

# index.html 必须存在（早期缺失过，见 §7 Q12）
docker exec pv-ac-sim ls /public/base-elements/index.html

# 17 个 SVG 至少能看到
docker exec pv-ac-sim ls /public/base-elements/ | wc -l
# 应 ≥ 18（17 SVG + index.html）
```

### 6.2 端口监听

```bash
curl -I http://localhost:8080
```

应返回 `HTTP/1.1 200 OK`。

### 6.3 SVG 资源访问

```bash
curl -I http://localhost:8080/base-elements/pv-array.svg
```

应返回 `HTTP/1.1 200 OK`，`Content-Type: image/svg+xml`。

### 6.4 JS bundle 能否访问

```bash
JS_PATH=$(curl -s http://localhost:8080 | grep -oE '/assets/index-[^"]+\.js' | head -1)
curl -I http://localhost:8080$JS_PATH
```

应返回 `HTTP/1.1 200 OK`。

### 6.5 浏览器访问（主页面）

打开 `http://<server-ip>:8080`，应看到原理图页面（14 个部件正常渲染）。

### 6.6 浏览器访问（index.html）

打开 `http://<server-ip>:8080/base-elements/index.html`（或 `http://<server-ip>:8080/base-elements/`），应看到：
- 14 个部件 + 3 种线缆的卡片网格
- 18 个部件 Tooltip（鼠标悬停）
- 数据控制台（15 滑块 + 9 预设 + 应用/随机/重置按钮）

### 6.7 index.html 内部资源验证

```bash
# 1. 确认 index.html 文件存在于镜像
docker exec pv-ac-sim ls -la /public/base-elements/index.html

# 2. 确认 index.html 可访问
curl -I http://localhost:8080/base-elements/index.html
# 应返回 HTTP/1.1 200 OK, Content-Type: text/html

# 3. 确认 index.html 能加载 SVG（模拟浏览器行为）
curl -I http://localhost:8080/base-elements/tank.svg
# 应返回 HTTP/1.1 200 OK, Content-Type: image/svg+xml
```

---

## 7. FAQ

### Q1: docker build 卡在 pnpm install 很久？

正常。首次需要下载 ~50MB 依赖。锁文件已固定 (`pnpm-lock.yaml`)，重 build 会走缓存，几秒完成。

### Q2: 服务器访问 `/base-elements/*.svg` 返回 404？

检查两件事：

```bash
# 1. 镜像内文件是否存在
docker exec pv-ac-sim ls /public/base-elements/

# 2. httpd 是否在运行
docker logs pv-ac-sim
```

### Q3: 服务器在国内，docker pull 太慢？

配置 Docker 镜像加速：

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<-'EOF'
{
  "registry-mirrors": [
    "https://mirror.ccs.tencentyun.com",
    "https://docker.mirrors.ustc.edu.cn"
  ]
}
EOF
sudo systemctl restart docker
```

### Q4: 为什么不用 node:20-slim 而用 node:20-alpine？

| 镜像 | 大小 | 兼容性 |
|---|---|---|
| `node:20` | ~900MB | 全功能 |
| `node:20-slim` | ~250MB | Debian slim |
| `node:20-alpine` | **~180MB** | musl libc |

本项目是纯前端，无 native 模块依赖，alpine 完全够用，且体积最小。

### Q5: busybox httpd 安全吗？

busybox httpd 是 AC httpd 的精简版，几十年来广泛用于嵌入式设备。无已知严重漏洞。对内网工具完全够用。

### Q6: 改了代码后如何重新部署？

```bash
# 本地
cd /Users/bbben/Desktop/photovoltaic-air-conditioner
tar -czf pv-ac-sim-src.tar.gz --exclude=... .   # 同 §2 命令
scp pv-ac-sim-src.tar.gz user@server:/opt/

# 服务器
ssh user@server
cd /opt
docker stop pv-ac-sim && docker rm pv-ac-sim
tar -xzf pv-ac-sim-src.tar.gz
cd pv-ac-sim-src
docker build -t pv-ac-sim:latest .
docker run -d --name pv-ac-sim -p 8080:80 --restart unless-stopped pv-ac-sim:latest
```

### Q7: 为什么用两个基础镜像？

Dockerfile 的 `FROM` 不是只能用一次，**多阶段构建允许每个阶段用不同基础镜像**：
- 阶段 1（builder）`FROM node:20-alpine` — 装 Node + pnpm 来构建
- 阶段 2（runtime）`FROM busybox:stable` — 只要静态文件服务器

只用 1 个的话：
- 单用 node:20-alpine → 镜像 180MB，浪费空间且暴露构建工具
- 单用 busybox:stable → 没有 Node，跑不了 vite build

### Q8: 镜像内的 `/base-elements/*.svg` 能正常服务吗？

能。busybox httpd 自动 URL 解码，文件系统按字节匹配。`base-elements/` 目录原样复制进镜像。

### Q9: 服务器需要装 pnpm 吗？

不需要。pnpm 通过 `corepack` 在 `node:20-alpine` 镜像内激活，服务器环境只需 Docker。

### Q10: 日志怎么看？

```bash
docker logs pv-ac-sim           # 看 stdout/stderr
docker logs -f pv-ac-sim        # 实时跟踪
```

busybox httpd 会把每次 HTTP 请求打到 stdout。

### Q11: 镜像能再瘦身吗？

能，但收益有限。当前：
- builder: node:20-alpine（180MB，构建后丢弃）
- runtime: busybox:stable（5MB，最终运行只用这个）

最终运行容器只占 5MB（解压后），硬盘占用 185MB（含构建层）。如想再小可考虑 `distroless` 静态二进制，但复杂度上升。

### Q12: 访问 index.html 返回 404，但 SVG 都能访问？

**原因**：Vite 构建过程不会打包 `base-elements/index.html`（它不在 React 入口图里），所以 `apps/web/dist/` 目录里只有 17 个 SVG，没有 index.html。Dockerfile 中漏写了显式 COPY index.html 的步骤。

**修复**：在 Dockerfile 的 `RUN pnpm --filter web build` 之后加一行：

```dockerfile
# ⚠️ 关键：手动把 index.html 放进 dist（Vite 不会构建它）
COPY base-elements/index.html ./apps/web/dist/base-elements/index.html
```

修复后必须 **rebuild**：

```bash
ssh user@server
cd /opt
docker stop pv-ac-sim && docker rm pv-ac-sim
# 重新解压并 build（如已上传新 tar）
cd pv-ac-sim-src
docker build -t pv-ac-sim:latest .
docker run -d --name pv-ac-sim -p 8080:80 --restart unless-stopped pv-ac-sim:latest
```

---

## 8. 完整步骤一句话总结

1. **本地**：`tar` 打包源码（含 index.html，不含文档/依赖/data）→ `scp` 到服务器
2. **服务器**：`tar -xzf` 解压 → `vi Dockerfile` 粘贴 §4.3 内容 → `docker build` → `docker run -d -p 8080:80`
3. **访问**：
   - 主页面 → `http://服务器IP:8080/`
   - 旧版演示 → `http://服务器IP:8080/base-elements/index.html`（也支持 `/base-elements/`）

---

## 附录：服务器前置环境检查

```bash
docker --version       # 需 ≥ 20.10
df -h /                # 需 ≥ 2GB 可用空间（构建期临时占用）
free -h                # 需 ≥ 1GB 可用内存（pnpm install 期间）
```

构建完成后临时空间会释放（约 100MB 缓存层可清理）：

```bash
docker builder prune   # 清理构建缓存
```