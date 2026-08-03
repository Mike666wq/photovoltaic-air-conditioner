# 光伏·空调仿真平台：从零到生产的 CI/CD 操作手册

> 版本：v7.0（已按 2026-08-02 首次生产部署实测校正）
>
> 更新：2026-08-02
>
> 目标：按本文完成后，只需推送一个版本 Tag，GitHub 会构建镜像并推送 GHCR，生产服务器自动拉取该镜像、启动容器、检查健康状态；服务器不保存应用源码，也不构建镜像。

## 本次已验收的生产结果

本项目的 CI/CD 已完整跑通，当前验收基线如下：

- 推送 `main` 会运行 CI：安装依赖、TypeScript 检查、Vite 构建、Docker 构建与容器冒烟测试；不会发布生产镜像。
- 推送合法版本 Tag（如 `v0.2.1`）会运行 Release：校验 Tag 属于 `main`、构建镜像、推送 GHCR、上传部署配置并远程部署。
- 服务器只接收 `docker-compose.yml` 与 `deploy/deploy.sh`，应用源码不会上传到服务器。
- 服务器按 `ghcr.io/...@sha256:...` 不可变 digest 拉取镜像，并映射 `服务器:8765 → 容器:8080`。
- 应用健康检查为 `http://127.0.0.1:8080/health`，带 2 分钟启动宽限；部署脚本最长等待 5 分钟。
- 发布成功后会保存当前 Tag、digest 与 Compose 快照；新版本失败时自动恢复上一健康版本。
- 旧镜像默认保留在服务器上，便于回滚；Docker 不会因旧容器被替换而自动删除其镜像。

## 0. 先理解最终流程

```text
本地开发机
  编码、Git 提交、推送 GitHub
        │
        ├─ Pull Request / main：CI 检查代码与 Docker 容器
        │
        └─ main 上推送 vX.Y.Z Tag
                │
                ▼
GitHub Actions
  校验 Tag 属于 main → 构建 Docker 镜像 → 推送 GHCR
  → 将不可变 digest 交给服务器部署脚本
                │
                ▼
生产服务器
  docker compose pull ghcr.io/...@sha256:...
  → docker compose up -d → 健康检查 → 失败回滚上一 digest
```

**应用代码只进入 GitHub 和 GHCR 镜像，绝不上传到服务器。** Release 过程中会向服务器传送 `docker-compose.yml` 和 `deploy/deploy.sh` 两个很小的部署配置文件，用来升级部署规则；它们不是应用源码，也不参与镜像构建。

### CI、Release、Tag 与 digest 的关系

| 名称 | 触发方式 | 做什么 | 是否生成 GHCR 镜像 |
|---|---|---|---|
| `CI` | PR 或推送 `main` | typecheck、前端构建、临时 Docker 镜像构建和冒烟测试 | 否；临时镜像只存在于 Runner |
| `Release` | 推送 `vX.Y.Z` 或 `vX.Y.Z-rcN` Tag | 再次验证、构建并推送 GHCR、自动部署 | 是 |
| 版本 Tag | 例如 `v0.2.1` | 给人阅读和发布管理使用 | GHCR 中可见 |
| 镜像 digest | 例如 `@sha256:abc...` | 服务器实际部署的不可变镜像身份 | 永远指向同一镜像 |

GHCR 中会看到版本 Tag，但服务器的 `docker images` 或 `docker ps` 可能显示镜像 ID 或 `@sha256:...`，这是正常现象。部署故意使用 digest，而不是可被重新指向的 Tag，保证服务器运行的就是本次 Actions 构建并验收的镜像。

### 哪个配置文件负责什么

| 文件 | 职责 |
|---|---|
| `.github/workflows/ci.yml` | PR/main 的代码、前端和临时容器验证 |
| `.github/workflows/release.yml` | Tag 触发、构建并推送 GHCR、向服务器发起部署 |
| `Dockerfile` | 定义镜像如何构建以及容器内如何启动 Node 静态服务 |
| `.dockerignore` | 控制哪些本地文件不进入 GitHub Runner 的 Docker 构建上下文 |
| `docker-compose.yml` | 定义服务器使用哪个 digest、端口映射、场景卷、安全限制和健康检查 |
| `deploy/deploy.sh` | pull、启动、健康验收、版本快照、备份与失败回滚 |

## 必须遵守的首次上线顺序

下面就是文档从上到下的实际执行顺序；不要跳到后面的 GHCR Package 检查。

1. 本地创建首个 Git 提交，推送 `main`。
2. 等待 GitHub 的 **CI** 成功（绿色）。此时只验证构建，**不会**创建 GHCR 容器包。
3. 完成服务器第 9～13 节：root SSH 专用密钥、服务器指纹、Docker/Compose、`/opt/pv-ac-sim/.env`、防火墙、GHCR 拉取 Token 登录。
4. 回 GitHub 填写第 14 节的 5 个 `SERVER_*` Environment Secrets。
5. 在 main 创建并推送第一个发布 Tag，例如 `v0.2.0`。
6. GitHub 的 **Release** 工作流执行 `publish-image`，此时才自动创建 GHCR 容器包并推送镜像。
7. `publish-image` 成功后，才去 Packages 页面执行第 18 节的包权限/可见性检查；随后 `deploy` Job 自动在服务器拉取镜像。

---

# 第一部分：本地开发机（只做 Git，不需要 Docker）

本地的职责只有两件事：维护项目源码并把源码推到 GitHub。**本地不需要 Docker、不需要本地构建镜像、不需要登录 GHCR。** Docker 镜像由 GitHub Actions 构建；生产服务器只拉取镜像。

## 1. 从零初始化本地 Git 仓库

进入项目根目录：

```bash
cd /Users/bbben/Desktop/photovoltaic-air-conditioner
```

本地唯一必须的软件是 Git。首次使用 Git 时设置身份（已设置过可跳过）：

```bash
git config --global user.name "你的姓名"
git config --global user.email "你的GitHub邮箱@example.com"
```

若项目目录尚未有 Git 仓库，执行：

```bash
git init
git branch -M main
```

若项目已经存在 `.git`，**不要重复执行 `git init`**。用下面命令确认当前状态：

```bash
git branch --show-current
git status --short
```

预期分支为 `main`。如果只是第一次初始化，`git status` 会列出尚未提交的项目文件。

## 2. 先决定：哪些文件应进入 GitHub

不要一开始执行 `git add .`。当前项目文件可分为四类，先按表决定，再执行第 3 节命令。

| 类别 | 当前项目中的路径 | 是否应提交 | 原因 |
|---|---|---|---|
| 应用运行源码 | `apps/web/` | **必须** | GitHub Actions 构建前端镜像所需源码、配置与生产服务脚本 |
| SVG 视觉资源 | `base-elements/` | **必须** | Dockerfile 构建时会复制此目录，缺失则构建失败 |
| Node 依赖定义 | `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` | **必须** | CI 必须依赖 lockfile 安装一致依赖 |
| 镜像与部署定义 | `Dockerfile`、`.dockerignore`、`docker-compose.yml`、`deploy/` | **必须** | GitHub 构建镜像与服务器部署/回滚所需 |
| GitHub 自动化 | `.github/workflows/` | **必须** | 没有它就没有 CI、GHCR 镜像发布和自动部署 |
| Git 规则 | `.gitignore` | **必须** | 定义哪些本地文件不能上传 |
| 项目说明 | `README.md`、`AGENTS.md`、`CICD持续集成部署.md`、`CICD持续集成概念.md` | **建议提交** | 让仓库使用者理解项目与发布方式，不影响程序运行 |
| 原图参考 | `原理图.jpg` | **建议提交** | 约 348 KB；README 和 SVG 文档引用它，但应用运行不依赖它 |
| 实验数据 | `data/` | **不提交** | 数据量、隐私与版本膨胀；当前已由 `.gitignore` 忽略 |
| 运行时场景 | `scenarios/` | **不提交** | 服务器持久化数据，不属于源码 |
| 本地环境/缓存/产物 | `.env*`、`node_modules/`、`dist/`、`.pnpm-store/` | **不提交** | 可由配置、安装或构建恢复；当前已忽略 |
| 独立大型目录 | `apps/site/` | **不提交到本仓库** | 当前约 789 MB，且不被 `apps/web`、Dockerfile 或工作流引用；已忽略 |
| 嵌套调试页 | `apps/web/apps/` | **不提交** | 不是正式 Vite 目录，已忽略 |

### 一个需要你明确决定的文档策略

当前 `.gitignore` 含有 `*.md`，只显式放行少数 Markdown 文件。因此 `需求文档.md`、`功能需求.md`、`数据读入.md`、`项目构建进度.md` 等文件**目前不会上传 GitHub**。

这不会影响应用构建，但会导致 GitHub 仓库缺少部分设计资料。你有两种合理选择：

1. **源码仓库最小化**：保持当前规则，只提交上表“建议提交”的少数说明文档。
2. **完整项目资料仓库**：从 `.gitignore` 删除 `*.md` 这一行，再明确忽略确实不想公开的单个文档。

建议实验项目采用第 2 种，但是否公开完整需求/实验文档由你决定；本文不替你修改这个选择。

## 3. 首次提交：按分类逐项暂存

如果你采用“完整项目资料仓库”，请先按上面的第 2 种策略修改 `.gitignore`；如果采用最小化策略，直接执行以下命令：

```bash
# 1. 运行、构建、部署、自动化：必须提交
git add apps/web base-elements
git add package.json pnpm-lock.yaml pnpm-workspace.yaml
git add Dockerfile .dockerignore docker-compose.yml
git add deploy .github .gitignore

# 2. 说明文档：建议提交
git add README.md AGENTS.md CICD持续集成部署.md CICD持续集成概念.md

# 3. 原图参考：建议提交；若明确不想保存在 GitHub，可跳过本行
git add 原理图.jpg
```

暂存后**必须**检查清单：

```bash
git status --short
git diff --cached --name-only
```

清单中必须包含下列关键路径：

```text
.github/workflows/ci.yml
.github/workflows/release.yml
apps/web/
base-elements/
deploy/deploy.sh
Dockerfile
docker-compose.yml
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
```

清单中绝不能出现：

```text
.env
data/
scenarios/
node_modules/
apps/web/dist/
.pnpm-store/
```

若出现不应提交的文件，在“首个提交尚未创建”的阶段用下面命令只取消暂存它（文件本身不会被删除）：

```bash
git rm -r --cached -- <不应提交的路径>
```

确认无误后创建首个提交：

```bash
git commit -m "chore: initialize project and CI/CD"
```

## 4. 本地不做什么

下列操作不是首次上传 GitHub 的前提，也不是发布必需项：

```text
docker build
docker run
docker login ghcr.io
pnpm build
pnpm typecheck
```

它们由 GitHub Actions 自动完成。你可以日常开发时自行运行 Node/pnpm 检查，但它们是可选的本地自检，不影响“从零上传并启用 CI/CD”的流程。

---

# 第二部分：GitHub 网页配置

## 5. 创建 GitHub 仓库并推送源码

### 5.1 在 GitHub 网页创建空仓库

1. 登录 GitHub，右上角 `+` → **New repository**。
2. Owner 选择个人账号或组织。
3. Repository name 填 `photovoltaic-air-conditioner`。
4. Visibility：按项目要求选择 Private 或 Public。实验项目推荐 **Private**。
5. **不要**勾选 `Add a README file`、`.gitignore`、License；本地已有完整项目，勾选会额外生成首个远端提交。
6. 点击 **Create repository**。
7. 复制页面给出的 HTTPS 或 SSH 仓库地址。

### 5.2 从本地推送

将下面 URL 替换为真实地址：

```bash
git remote add origin git@github.com:YOUR_OWNER/photovoltaic-air-conditioner.git
git push -u origin main
```

若 `origin` 已存在，先查看而不是盲目覆盖：

```bash
git remote -v
```

确认错误后才修改：

```bash
git remote set-url origin git@github.com:YOUR_OWNER/photovoltaic-air-conditioner.git
git push -u origin main
```

打开 GitHub 仓库 `Code` 页面，确认能看到 `.github/workflows/ci.yml`、`.github/workflows/release.yml`、`Dockerfile`、`docker-compose.yml`。

## 6. GitHub Actions 基础权限

路径：仓库页面 **Settings → Actions → General**。

1. 在 `Actions permissions` 选择允许 Actions 运行。
2. 在 `Workflow permissions` 选择 **Read and write permissions**。
3. 勾选 `Allow GitHub Actions to create and approve pull requests` 不是本项目必须项，可不勾选。
4. 点击 **Save**。

原因：Release 工作流需要 `packages: write` 权限向 GHCR 推送镜像。工作流已显式声明该权限；仓库/组织策略也不能禁止它。

如果组织策略强制只读权限，应由组织管理员在组织级 Actions policy 中允许 Packages 写入，或在首次发布时根据 Actions 日志授予相应权限。

## 7. 设置 main 分支保护

路径：仓库 **Settings → Rules → Rulesets → New ruleset → New branch ruleset**。

按以下填写：

1. Ruleset name：`protect-main`。
2. Enforcement status：`Active`。
3. Target branches：添加 Include pattern，填 `main`。
4. 勾选 **Require a pull request before merging**；建议 Require approvals 为 1。
5. 勾选 **Require status checks to pass**，选择或输入 CI 运行后出现的检查名 `verify`。
6. 建议勾选 **Block force pushes**、**Restrict deletions**。
7. 管理员也应遵守规则时，不给 Administrator bypass。
8. 点击 **Create**。

注意：`verify` 状态检查只有 CI 至少运行一次才会出现在候选列表。若首次配置时看不到，先创建一个测试 PR 触发 CI，再回来添加必需检查。GitHub 规则集的具体可用项受账号/组织套餐与策略影响。

## 8. 设置 Tag 保护

路径：仓库 **Settings → Rules → Rulesets → New ruleset → New tag ruleset**。

建议：

1. 名称：`protect-release-tags`。
2. Target tags：Include pattern 填 `v*`。
3. 启用 Restrict creations、Restrict updates、Restrict deletions。
4. 仅给发布负责人/发布团队添加 bypass 权限。
5. 状态设为 Active 后 Create。

目的：避免他人覆盖或删除已发布版本。Tag 指向的提交不可随意改写。

## 8.1 创建 production Environment 与部署审批

路径：仓库 **Settings → Environments → New environment**。

1. 名称填 `production`，必须与 `release.yml` 中 `environment: production` 一致。
2. 点击 **Configure environment**。
3. 勾选 **Required reviewers**，添加至少一位发布审批人。
4. 如页面提供 Deployment branches/tags 限制，选择仅允许受保护分支/Tag 或匹配 `v*` 的发布 Tag。
5. 点击 **Save protection rules**。

以后推送 Tag 后，`deploy` Job 会处于等待状态。审批人打开 `Actions → Release`，点击 **Review deployments**，核对 Tag、提交和变更后才选择 Approve and deploy。

若仓库套餐/组织策略不支持私有仓库 Environment 审批，依旧可运行自动部署；此时必须严格控制 Tag 创建权限。

# 第三部分：生产服务器（先完成这里）

以下按你的决定，以 **Debian 12（Bookworm）**、SSH 端口 22、`root` 直接部署为例。命令中的 `SERVER_IP` 必须替换为真实值。

> 注意：GitHub Actions 使用 root 私钥意味着该私钥泄露可直接取得服务器完整控制权。请只使用专用部署密钥、保留主机指纹校验，并绝不把私钥提交到仓库。

## 9. 配置 root 的专用部署 SSH 密钥

### 9.1 本地创建独立部署密钥

在本地开发机：

```bash
ssh-keygen -t ed25519 -C "github-actions-pv-ac-sim" \
  -f ~/.ssh/pv-ac-sim-deploy -N ""
```

将公钥安装到服务器 root：

```bash
ssh-copy-id -i ~/.ssh/pv-ac-sim-deploy.pub -p 22 root@SERVER_IP
```

如果本机没有 `ssh-copy-id`：

```bash
cat ~/.ssh/pv-ac-sim-deploy.pub | ssh -p 22 root@SERVER_IP \
  'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys'
```

服务器必须允许 root 使用密钥登录。检查：

```bash
sudo sshd -T | grep '^permitrootlogin'
```

期望是 `permitrootlogin prohibit-password` 或 `permitrootlogin yes`；不要为了部署开启 root 密码登录。修改 `/etc/ssh/sshd_config` 后，先保持一个现有 SSH 会话不关闭，再执行 `sudo systemctl reload ssh`。

验证：

```bash
ssh -i ~/.ssh/pv-ac-sim-deploy -p 22 root@SERVER_IP 'whoami && hostname'
```

预期 `whoami` 输出 `root`。保存私钥内容，稍后第 14 节填写 `SERVER_SSH_KEY`：

```bash
cat ~/.ssh/pv-ac-sim-deploy
```

不要把该私钥提交到项目或发到普通聊天。

### 9.2 获取并核验服务器指纹

`SERVER_FINGERPRINT` 必须是 GitHub Actions 通过 `SERVER_HOST` 和 `SERVER_PORT` **实际连到的那台 SSH 服务**所提供的主机密钥指纹；它不是第 9.1 节部署私钥的指纹。

先在服务器控制台或已可信 SSH 会话中，列出 sshd 当前实际配置的全部主机密钥及其指纹：

```bash
sudo sshd -T | awk '$1 == "hostkey" { print $2 }' | \
  while read -r key; do ssh-keygen -lf "$key" -E sha256; done
```

再在本地，使用将要填写到 `SERVER_HOST`、`SERVER_PORT` 的**完全相同地址和端口**查询对外可见的主机密钥：

```bash
ssh-keyscan -T 10 -p SERVER_PORT SERVER_HOST 2>/dev/null | \
  ssh-keygen -lf - -E sha256
```

输出会有一行或多行 `SHA256:...`。从中选择与服务器上实际启用密钥一致的一项，完整填入 `SERVER_FINGERPRINT`（只填 `SHA256:...`，不要填位数、算法名、IP 或公钥正文）。服务器通常同时提供 RSA、ECDSA、ED25519 主机密钥，`drone-scp`/`drone-ssh` 实际协商哪一种取决于客户端版本；本项目首次部署时协商的是 ECDSA，因此不能默认认为一定是 ED25519。

如果 Actions 报 `ssh: host key fingerprint mismatch`：

1. 确认 Secret 添加在 `production` 的 **Environment secrets**，不是 Environment variables。
2. 确认 `SERVER_HOST`、`SERVER_PORT` 与本地 `ssh-keyscan` 使用的值完全一致。
3. 只允许改用上面两端核验结果中同时存在的另一个 RSA/ECDSA/ED25519 指纹；不能填未经可信服务器控制台确认的指纹，也不能删除工作流中的 fingerprint 校验。
4. 指纹修正后可在失败运行中选择 **Re-run failed jobs**，无需重新创建 Tag。

常见原因是 `SERVER_HOST` 填成了另一台机器/旧 IP、域名 DNS 指向不同主机、端口转发到另一台 SSH 服务器，或 sshd 配置使用了非默认的 HostKey 文件。只做 `ssh-keyscan` 而不和可信服务器控制台的结果比对，不足以防止中间人攻击。

## 10. 安装 Docker Engine 与 Compose V2

登录 root：

```bash
ssh -p 22 root@SERVER_IP
```

以下为 Debian 12 官方 Docker apt 仓库安装方式。若服务器以前安装过 Debian 自带的旧 Docker，先卸载可能冲突的包：

```bash
apt remove -y docker.io docker-compose docker-doc podman-docker containerd runc || true
apt update
apt install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: bookworm
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
```

验证 Docker（`hello-world` 成功后会自动退出）：

```bash
docker --version
docker compose version
docker ps
docker run --rm hello-world
```

root 可直接运行 Docker，不需要加入 Docker 组。

## 11. 创建生产目录、环境文件和防火墙

在服务器上：

```bash
sudo mkdir -p /opt/pv-ac-sim/scenarios
sudo mkdir -p /opt/pv-ac-sim/backups
sudo mkdir -p /opt/pv-ac-sim/deploy/versions
sudo chown -R root:root /opt/pv-ac-sim
chmod 750 /opt/pv-ac-sim /opt/pv-ac-sim/scenarios
cd /opt/pv-ac-sim
id -u
id -g
```

用 `nano .env` 或 `vim .env` 创建文件，填入实际 UID/GID：

```dotenv
APP_UID=0
APP_GID=0
WEB_BIND_IP=0.0.0.0
WEB_PORT=8765
```

```bash
chmod 600 .env
grep -E '^(APP_UID|APP_GID|WEB_BIND_IP|WEB_PORT)=' .env
```

不要把 `.env` 推送到 GitHub。它目前不含密钥，但以后可能增加敏感字段。

Debian 默认不一定安装 UFW；如需使用 UFW，先安装。**先放行 SSH，再启用防火墙**：

```bash
apt install -y ufw
ufw allow 22/tcp
ufw allow 8765/tcp
ufw enable
ufw status numbered
```

云服务器控制台的安全组/防火墙也必须放行 TCP 22 和 8765。若 SSH 端口不是 22，先放行真实端口再启用 UFW。

Docker 发布端口可能绕过 UFW 的普通规则；如需严格限制公网来源，应同时配置云安全组，或将规则加入 Docker 的 `DOCKER-USER` 链。当前项目要求公开 `8765/tcp`，云安全组放行是最直接的做法。

---

# 第四部分：GHCR 拉取凭据（完成服务器后再做）

## 12. 创建服务器拉取私有镜像的 Token

此时 Packages 页面仍可能没有任何容器包，这是正常的。创建 Token 不依赖包已经存在。

GitHub Container Registry 的服务器 Docker 登录使用 **Personal access token (classic)**：GitHub 右上角头像 → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**。

填写 Note `pv-ac-sim-server-pull`，选择合理到期日，只勾选 `read:packages`，生成后立即复制到密码管理器。30 天可以使用，90 天可减少轮换频率；无论选多久，都应在到期前创建新 Token、重新登录并验证 pull，再吊销旧 Token。不要使用 fine-grained PAT，也不要勾选 `repo` 或 `write:packages`。

## 13. 在服务器登录 GHCR

仍在服务器，以 `root` 身份执行：

```bash
printf '%s' '第12节创建的完整Token' | \
  docker login ghcr.io -u GITHUB_USERNAME --password-stdin
```

`GITHUB_USERNAME` 填创建该 Token 的 GitHub 登录名，并确保该账号有权读取这个 Package；例如账号为 `Mike666wq` 时填写 `Mike666wq`，不是邮箱、服务器用户名或仓库名。

期望输出 `Login Succeeded`。这会把凭据保存在 `~/.docker/config.json`（或配置的 Docker credential helper），不要放进 `/opt/pv-ac-sim/.env`。

看到 `Login Succeeded` 即可；此时还不能 pull，因为第一个镜像尚未发布。凭据保存在 `/root/.docker/config.json`，不要写入项目 `.env`。

---

# 第五部分：回到 GitHub 填部署 Secrets

## 14. 配置 GitHub 部署 Secrets

路径：仓库 **Settings → Environments → production → Environment secrets → Add environment secret**。此时你已经有 root SSH 密钥与服务器指纹，逐个添加：

| Name | 填写内容 |
|---|---|
| `SERVER_HOST` | 服务器公网 IP 或域名，不带 `http://` |
| `SERVER_PORT` | SSH 端口，例如 `22` |
| `SERVER_USER` | `root` |
| `SERVER_SSH_KEY` | 第 9 节生成的私钥全文 |
| `SERVER_FINGERPRINT` | 第 9 节核验的 `SHA256:...` |

不要把 GHCR Token 放到 GitHub Secret，它只保存在服务器 Docker 凭据中。

---

# 第六部分：首次发布、Package 自动创建与验收

## 15. 首次发布前的最终检查

本地必须检查 Git 状态：

```bash
cd /Users/bbben/Desktop/photovoltaic-air-conditioner
git status --short
git log --oneline -1
git branch --show-current
```

`git status --short` 应无输出，当前分支应为 `main`。本地仍不要求安装 pnpm 或 Docker；如本地已经有 Node/pnpm，可选执行 `pnpm --filter web typecheck` 和 `pnpm --filter web build`，最终以 GitHub CI 绿色为准。

GitHub：

- main 已有 CI 成功记录。
- `production` Environment、5 个服务器 Secret 已配置。
- `release.yml` 已推到 main。

服务器：

- `docker ps` 无权限错误。
- `/opt/pv-ac-sim/.env` 存在。
- `docker login ghcr.io` 成功（私有镜像）。
- 安全组与 UFW 已开放端口。

## 16. 推送第一个发布 Tag

确认 main 是目标提交后：

```bash
git checkout main
git pull --ff-only origin main
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

不要推送包含其他历史 Tag 的 `git push --tags`。

## 17. 在 GitHub Actions 中跟踪首发

路径：仓库 **Actions → Release → 本次 Tag 对应运行**。

按顺序确认：

1. `verify` 为绿色：Tag 合法、提交在 main、typecheck/build 成功。
2. `publish-image` 为绿色：GHCR 登录、Buildx 构建、push 成功。
3. `deploy` 显示等待时，审批人点击 **Review deployments** → 选择 `production` → **Approve and deploy**；没有审批功能时它会自动继续。
4. `deploy` 为绿色，并在日志中看到 `部署成功：v0.2.0` 和 digest。

首次部署仅上传 Compose 和部署脚本；服务器不会接收 Dockerfile、`apps/`、`base-elements/`、Node 依赖和实验数据。

三个 Job 的含义必须分清：`publish-image` 成功说明镜像已经进入 GHCR；SCP 步骤只上传部署配置，不是上传镜像；最后的 SSH 步骤才让服务器执行 `docker compose pull` 并启动容器。

## 18. Release 成功后检查自动创建的 GHCR Package

只有第 17 节的 `publish-image` 变绿后，再打开 GitHub 个人主页或组织主页的 **Packages**。此时应出现 `photovoltaic-air-conditioner` 的 **Container** 包，且包含 `v0.2.0` Tag。

打开 Package → **Package settings**，确认：

1. Owner 与包名正确，并已关联当前 repository。
2. 私有项目建议保持 **Private**；服务器已在第 13 节登录 GHCR，所以可拉取私有镜像。
3. 不删除已经部署过的 Tag 或 digest，否则手动回滚可能失败。

如果 `publish-image` 失败，Package 不会出现；返回 Actions 查看该 Job 的红色步骤，而不是在 Packages 页面手动创建容器。

## 19. 首发验收

服务器执行：

```bash
cd /opt/pv-ac-sim
cat current-release
cat current-image
docker ps --filter name=pv-ac-sim-web
docker inspect --format='{{.State.Health.Status}}' pv-ac-sim-web
curl --fail http://127.0.0.1:8765/health
curl --fail http://127.0.0.1:8765/
```

从另一网络：

```bash
curl --fail http://SERVER_IP:8765/health
```

浏览器访问 `http://SERVER_IP:8765/`，检查首页、SVG 资源、场景保存/刷新读取/删除。

最终必须同时满足：Release 全部绿色、`current-release` 是本次 Tag、`current-image` 是本次 digest、容器状态为 `healthy`、内网和公网 `/health` 都返回 HTTP 200。页面暂时能打开但容器仍为 `unhealthy`，不能算完整验收成功。

## 20. 后续正常发布

每次都遵守相同流程：功能分支 → PR → CI 绿 → 合并 main → main CI 绿 → 新 Tag。

```bash
git checkout main
git pull --ff-only origin main
git tag -a v0.2.1 -m "Release v0.2.1"
git push origin v0.2.1
```

服务器会直接拉取新的 digest，不需要 SSH 上去执行构建命令。

---

# 第七部分：运行、回滚和故障

## 21. 查看状态和日志

```bash
cd /opt/pv-ac-sim
cat current-release
cat current-image
docker ps -a --filter name=pv-ac-sim-web
docker logs --tail 200 pv-ac-sim-web
docker stats --no-stream pv-ac-sim-web
docker system df
df -h /opt/pv-ac-sim
```

### 为什么服务器显示 digest，而不是版本 Tag

Release 同时向 GHCR 写入 `vX.Y.Z`（正式版还写入 `latest`）并取得镜像 digest。部署脚本只使用 digest，例如：

```text
ghcr.io/mike666wq/photovoltaic-air-conditioner@sha256:4ca0...
```

因此 `docker images` 中不一定显示 `vX.Y.Z`，但可通过以下文件确认版本与镜像的一一对应关系：

```bash
cat /opt/pv-ac-sim/current-release
cat /opt/pv-ac-sim/current-image
find /opt/pv-ac-sim/deploy/versions -maxdepth 2 -type f -print
```

## 22. 手动回滚应用

列出可回滚版本：

```bash
cd /opt/pv-ac-sim
find deploy/versions -mindepth 1 -maxdepth 1 -type d -print
```

回滚：

```bash
./deploy/deploy.sh v0.2.0
```

脚本读取该版本保存的 digest 与 Compose 快照，pull 并启动；不会构建镜像。应用回滚不回滚 `scenarios/` 数据。

## 23. 场景备份

每次发布前自动创建同机备份并保留最近 10 份：

```text
/opt/pv-ac-sim/backups/scenarios-pre-<tag>-<timestamp>.tar.gz
```

重要场景还应定期备份到服务器外：

```bash
cd /opt/pv-ac-sim
backup="/tmp/pv-ac-scenarios-$(date +%Y%m%d-%H%M%S).tar.gz"
tar --exclude='scenarios/*.tmp' -czf "$backup" scenarios/
ls -lh "$backup"
```

## 24. 常见问题

| 问题 | 排查顺序 |
|---|---|
| GitHub 无法 push GHCR | Actions 权限是否为读写；workflow 是否有 `packages: write`；Package 是否关联仓库 |
| 服务器无法 pull | `docker login ghcr.io`；classic PAT 的 `read:packages`；账号的 Package 读取权限；服务器能访问 ghcr.io |
| Actions 报指纹不匹配 | Secret 必须位于 `production` 的 Environment secrets；核对实际 Host/Port；从服务器与 `ssh-keyscan` 的交集选择动作实际协商的主机密钥指纹 |
| Actions 无法 SSH | `SERVER_*` Secret；root 公钥；`PermitRootLogin`；UFW/安全组 |
| 容器 unhealthy | 看健康日志时间与配置；容器内执行 `wget http://127.0.0.1:8080/health`；宿主机执行 `curl 127.0.0.1:8765/health`；检查应用日志与场景目录权限 |
| 本机正常但公网不可达 | Compose 端口映射、`WEB_BIND_IP=0.0.0.0`、UFW、云安全组 |
| 场景保存失败 | `ls -ld /opt/pv-ac-sim/scenarios` 与 `.env` 中 APP_UID/APP_GID 是否对应 |

健康检查必须使用 `127.0.0.1`，不要改回 `localhost`。容器内 `localhost` 可能优先解析到 IPv6 `::1`，而当前 Node 服务监听 IPv4 `0.0.0.0:8080`，会导致页面能打开但 Docker 持续报告 `unhealthy`。

### 旧镜像为什么没有自动删除

这是 Docker 默认行为，也是本项目当前的保守回滚策略：Compose 替换旧容器时不会自动删除旧镜像，部署脚本也不会在发布成功后执行全局清理。旧镜像可加快回滚，并在 GHCR 临时不可用时提供额外保障。

定期用 `docker system df` 观察空间。只有磁盘空间确实紧张、已确认当前 digest 和至少一个回滚版本仍可用、并确认 GHCR 中对应 digest 未删除时，才按**明确的旧 digest**执行 `docker image rm ghcr.io/...@sha256:旧摘要`。不要在共享服务器执行 `docker system prune -a`，它可能删除其他应用镜像和回滚所需镜像。

## 25. 安全注意事项

- 当前服务是 HTTP，未配置 HTTPS。
- 场景 API 当前无认证；公网可访问者可能读写/删除场景。
- `SERVER_SSH_KEY`、GHCR classic PAT、Docker 组权限都需要严格保护。
- 当前按项目要求使用服务器 root SSH，并且生产 `.env` 为 `APP_UID=0`、`APP_GID=0`，容器也以 root 运行；这是已知的安全取舍，后续可单独迁移到受限部署用户和非 root 容器 UID。
- Token 到期前应轮换：创建新 Token → 服务器重新 docker login → 验证 pull → 吊销旧 Token。
- 发布脚本自动回滚应用镜像，但不自动回滚场景数据。
- 将来应优先增加 HTTPS 反向代理、场景 API 认证、异地备份、监控告警和 E2E 测试。

官方参考：[GitHub Actions 发布 Packages](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions)、[GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)、[GitHub Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)。
