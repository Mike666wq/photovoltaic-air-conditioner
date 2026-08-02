# 光伏·空调仿真平台：从零到生产的 CI/CD 操作手册

> 版本：v6.0（GitHub Actions → GHCR → Docker Compose）
>
> 更新：2026-08-02
>
> 目标：按本文完成后，只需推送一个版本 Tag，GitHub 会构建镜像并推送 GHCR，生产服务器自动拉取该镜像、启动容器、检查健康状态；服务器不保存应用源码，也不构建镜像。

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

## 4. 创建 GitHub 仓库并推送源码

### 4.1 在 GitHub 网页创建空仓库

1. 登录 GitHub，右上角 `+` → **New repository**。
2. Owner 选择个人账号或组织。
3. Repository name 填 `photovoltaic-air-conditioner`。
4. Visibility：按项目要求选择 Private 或 Public。实验项目推荐 **Private**。
5. **不要**勾选 `Add a README file`、`.gitignore`、License；本地已有完整项目，勾选会额外生成首个远端提交。
6. 点击 **Create repository**。
7. 复制页面给出的 HTTPS 或 SSH 仓库地址。

### 4.2 从本地推送

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

## 5. GitHub Actions 基础权限

路径：仓库页面 **Settings → Actions → General**。

1. 在 `Actions permissions` 选择允许 Actions 运行。
2. 在 `Workflow permissions` 选择 **Read and write permissions**。
3. 勾选 `Allow GitHub Actions to create and approve pull requests` 不是本项目必须项，可不勾选。
4. 点击 **Save**。

原因：Release 工作流需要 `packages: write` 权限向 GHCR 推送镜像。工作流已显式声明该权限；仓库/组织策略也不能禁止它。

如果组织策略强制只读权限，应由组织管理员在组织级 Actions policy 中允许 Packages 写入，或在首次发布时根据 Actions 日志授予相应权限。

## 6. 设置 main 分支保护

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

## 7. 设置 Tag 保护

路径：仓库 **Settings → Rules → Rulesets → New ruleset → New tag ruleset**。

建议：

1. 名称：`protect-release-tags`。
2. Target tags：Include pattern 填 `v*`。
3. 启用 Restrict creations、Restrict updates、Restrict deletions。
4. 仅给发布负责人/发布团队添加 bypass 权限。
5. 状态设为 Active 后 Create。

目的：避免他人覆盖或删除已发布版本。Tag 指向的提交不可随意改写。

## 8. 创建 production Environment 与部署审批

路径：仓库 **Settings → Environments → New environment**。

1. 名称填 `production`，必须与 `release.yml` 中 `environment: production` 一致。
2. 点击 **Configure environment**。
3. 勾选 **Required reviewers**，添加至少一位发布审批人。
4. 如页面提供 Deployment branches/tags 限制，选择仅允许受保护分支/Tag 或匹配 `v*` 的发布 Tag。
5. 点击 **Save protection rules**。

以后推送 Tag 后，`deploy` Job 会处于等待状态。审批人打开 `Actions → Release`，点击 **Review deployments**，核对 Tag、提交和变更后才选择 Approve and deploy。

若仓库套餐/组织策略不支持私有仓库 Environment 审批，依旧可运行自动部署；此时必须严格控制 Tag 创建权限。

## 9. 配置 GitHub 部署 Secrets

路径：建议使用环境级 Secret：**Settings → Environments → production → Environment secrets → Add secret**。

逐个添加：

| Name | 填写内容 | 示例 |
|---|---|---|
| `SERVER_HOST` | 服务器公网 IP 或域名；不带 `http://` | `203.0.113.10` |
| `SERVER_PORT` | SSH 端口 | `22` |
| `SERVER_USER` | 部署用户 | `pvdeploy` |
| `SERVER_SSH_KEY` | 第 15 节生成的私钥全文 | 从 `BEGIN OPENSSH PRIVATE KEY` 到结尾 |
| `SERVER_FINGERPRINT` | 已人工核验的服务器 ED25519 SHA256 指纹 | `SHA256:abc...` |

每填一项点击 **Add secret**。Secret 保存后无法再读取，这是正常行为；复制时要妥善保管。

不要把 `GHCR_READ_TOKEN` 放进 GitHub Actions Secret：它只供服务器拉取私有镜像，应该只保存在服务器 Docker 凭据中。

---

# 第三部分：GHCR 镜像仓库

## 10. 第一次发布会自动创建 GHCR 包

不需要先手动创建容器仓库。首次成功推送发布 Tag 时，`release.yml` 使用 GitHub 自动提供的 `GITHUB_TOKEN`，将镜像推送到：

```text
ghcr.io/<GitHub Owner>/photovoltaic-air-conditioner
```

工作流已声明：

```yaml
permissions:
  contents: read
  packages: write
```

首次成功后，在 GitHub 个人主页或组织主页的 **Packages** 中找到 `photovoltaic-air-conditioner` 容器包。

## 11. 检查 GHCR 包配置

打开该 Package → **Package settings**，逐项核对：

1. 确认 package name 和 Owner 正确。
2. 确认 package 已关联当前 GitHub repository；未关联时按页面提示 Connect repository。
3. 在 `Manage Actions access` 中，确认当前仓库具备发布/访问包的权限。首次由本仓库工作流发布时通常会自动关联；若 Actions 报 package access 错误，在此页面添加仓库。
4. 选择 Visibility：
   - **Private（推荐）**：服务器需要 GHCR 登录 Token；镜像不公开。
   - Public：任何人都能下载镜像；服务器可免登录 pull。
5. 不要删除已部署版本的 package tag/digest；否则回滚可能失败。

## 12. 创建服务器拉取私有镜像的 Token

截至本文更新，GitHub Container Registry 的服务器 Docker 登录使用 **Personal access token (classic)**。不要创建 fine-grained PAT 来替代它。

在拥有包访问权限的 GitHub 账号中：

1. GitHub 右上角头像 → **Settings**。
2. 左侧最底部 **Developer settings**。
3. **Personal access tokens → Tokens (classic)**。
4. 点击 **Generate new token → Generate new token (classic)**。
5. Note 填 `pv-ac-sim-server-pull`。
6. Expiration 选择尽可能短但可运维的期限，例如 90 天；记录到期日。
7. 勾选唯一需要的 scope：`read:packages`。
8. 点击 **Generate token**，立即复制并保存在密码管理器。页面关闭后不会再次显示。

这是只读 Token：它只能拉取镜像，不能推送。不要使用有 `repo`、`write:packages` 或管理员权限的个人 Token。

---

# 第四部分：生产服务器

以下以 Ubuntu 22.04/24.04、SSH 端口 22、部署用户 `pvdeploy` 为例。命令中的 `SERVER_IP`、用户名、UID/GID 必须替换为真实值。

## 13. 创建部署用户与 SSH 密钥

### 13.1 服务器创建部署用户

使用已有管理员账户登录服务器：

```bash
ssh root@SERVER_IP
adduser pvdeploy
usermod -aG sudo pvdeploy
exit
```

以后应使用 `pvdeploy` 部署，不要把 GitHub Actions 的私钥配置为 root 登录。

### 13.2 本地创建独立部署密钥

在本地开发机：

```bash
ssh-keygen -t ed25519 -C "github-actions-pv-ac-sim" \
  -f ~/.ssh/pv-ac-sim-deploy -N ""
```

安装公钥：

```bash
ssh-copy-id -i ~/.ssh/pv-ac-sim-deploy.pub -p 22 pvdeploy@SERVER_IP
```

如果本机没有 `ssh-copy-id`：

```bash
cat ~/.ssh/pv-ac-sim-deploy.pub | ssh -p 22 pvdeploy@SERVER_IP \
  'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys'
```

验证：

```bash
ssh -i ~/.ssh/pv-ac-sim-deploy -p 22 pvdeploy@SERVER_IP 'whoami && hostname'
```

预期 `whoami` 输出 `pvdeploy`。把私钥内容复制到第 11 节的 `SERVER_SSH_KEY`：

```bash
cat ~/.ssh/pv-ac-sim-deploy
```

不要把该私钥提交到项目或发到普通聊天。

### 13.3 获取并核验服务器指纹

先在服务器控制台或已可信 SSH 会话中执行：

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

记下 `SHA256:...`。本地再查询：

```bash
ssh-keyscan -t ed25519 -p 22 SERVER_IP > /tmp/pv-ac-sim-known-host
ssh-keygen -lf /tmp/pv-ac-sim-known-host -E sha256
```

两者必须完全一致；一致后才把摘要填进 `SERVER_FINGERPRINT`。只做 `ssh-keyscan` 不足以防止中间人攻击。

## 14. 安装 Docker Engine 与 Compose V2

登录部署用户：

```bash
ssh -p 22 pvdeploy@SERVER_IP
```

以下为 Ubuntu 官方 Docker apt 仓库安装方式：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
$(. /etc/os-release && echo \"${UBUNTU_CODENAME:-$VERSION_CODENAME}\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
exit
```

重新登录后验证 Docker 组权限：

```bash
ssh -p 22 pvdeploy@SERVER_IP
docker --version
docker compose version
docker ps
```

若 `docker ps` 仍提示 permission denied，确认已经重新登录。Docker 组拥有接近 root 的宿主机控制能力，只应加入可信部署用户。

## 15. 创建生产目录、环境文件和防火墙

在服务器上：

```bash
sudo mkdir -p /opt/pv-ac-sim/scenarios
sudo mkdir -p /opt/pv-ac-sim/backups
sudo mkdir -p /opt/pv-ac-sim/deploy/versions
sudo chown -R "$USER":"$USER" /opt/pv-ac-sim
chmod 750 /opt/pv-ac-sim /opt/pv-ac-sim/scenarios
cd /opt/pv-ac-sim
id -u
id -g
```

用 `nano .env` 或 `vim .env` 创建文件，填入实际 UID/GID：

```dotenv
APP_UID=1000
APP_GID=1000
WEB_BIND_IP=0.0.0.0
WEB_PORT=8765
```

```bash
chmod 600 .env
grep -E '^(APP_UID|APP_GID|WEB_BIND_IP|WEB_PORT)=' .env
```

不要把 `.env` 推送到 GitHub。它目前不含密钥，但以后可能增加敏感字段。

Ubuntu UFW 示例：

```bash
sudo ufw allow 22/tcp
sudo ufw allow 8765/tcp
sudo ufw enable
sudo ufw status numbered
```

云服务器控制台的安全组/防火墙也必须放行 TCP 22 和 8765。若 SSH 端口不是 22，先放行真实端口再启用 UFW。

## 16. 在服务器登录 GHCR

仍在服务器，以 `pvdeploy` 身份执行：

```bash
printf '%s' '第12节创建的完整Token' | \
  docker login ghcr.io -u GITHUB_USERNAME --password-stdin
```

期望输出 `Login Succeeded`。这会把凭据保存在 `~/.docker/config.json`（或配置的 Docker credential helper），不要放进 `/opt/pv-ac-sim/.env`。

第一次 GHCR 镜像发布成功后，可先手动测试拉取：

```bash
docker pull ghcr.io/YOUR_OWNER/photovoltaic-air-conditioner:v0.2.0
```

私有镜像若报 `denied`，按顺序检查：Token 是 classic、包含 `read:packages`、创建 Token 的账号有该 Package 的读取权限、GHCR Package 保持 Private 但允许该账号读取。

---

# 第五部分：首次发布和日常发布

## 17. 首次发布前的最终检查

本地：

```bash
cd /Users/bbben/Desktop/photovoltaic-air-conditioner
git status --short
git log --oneline -1
git branch --show-current
pnpm --filter web typecheck
pnpm --filter web build
```

GitHub：

- main 已有 CI 成功记录。
- `production` Environment、5 个服务器 Secret 已配置。
- `release.yml` 已推到 main。

服务器：

- `docker ps` 无权限错误。
- `/opt/pv-ac-sim/.env` 存在。
- `docker login ghcr.io` 成功（私有镜像）。
- 安全组与 UFW 已开放端口。

## 18. 推送第一个发布 Tag

确认 main 是目标提交后：

```bash
git checkout main
git pull --ff-only origin main
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

不要推送包含其他历史 Tag 的 `git push --tags`。

## 19. 在 GitHub Actions 中跟踪首发

路径：仓库 **Actions → Release → 本次 Tag 对应运行**。

按顺序确认：

1. `verify` 为绿色：Tag 合法、提交在 main、typecheck/build 成功。
2. `publish-image` 为绿色：GHCR 登录、Buildx 构建、push 成功。
3. 打开 GHCR Package，确认出现 `v0.2.0` Tag。
4. 如果 `deploy` 显示等待，审批人点击 **Review deployments** → 选择 `production` → **Approve and deploy**。
5. `deploy` 为绿色，并在日志中看到 `部署成功：v0.2.0` 和 digest。

首次部署仅上传 Compose 和部署脚本；服务器不会接收 Dockerfile、`apps/`、`base-elements/`、Node 依赖和实验数据。

## 20. 首发验收

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

## 21. 后续正常发布

每次都遵守相同流程：功能分支 → PR → CI 绿 → 合并 main → main CI 绿 → 新 Tag。

```bash
git checkout main
git pull --ff-only origin main
git tag -a v0.2.1 -m "Release v0.2.1"
git push origin v0.2.1
```

服务器会直接拉取新的 digest，不需要 SSH 上去执行构建命令。

---

# 第六部分：运行、回滚和故障

## 22. 查看状态和日志

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

## 23. 手动回滚应用

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

## 24. 场景备份

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

## 25. 常见问题

| 问题 | 排查顺序 |
|---|---|
| GitHub 无法 push GHCR | Actions 权限是否为读写；workflow 是否有 `packages: write`；Package 是否关联仓库 |
| 服务器无法 pull | `docker login ghcr.io`；classic PAT 的 `read:packages`；账号的 Package 读取权限；服务器能访问 ghcr.io |
| Actions 无法 SSH | `SERVER_*` Secret；SSH 公钥；指纹；UFW/安全组；部署用户路径权限 |
| 容器 unhealthy | `docker logs --tail 200 pv-ac-sim-web`；`curl 127.0.0.1:8765/health`；场景目录 UID/GID |
| 本机正常但公网不可达 | Compose 端口映射、`WEB_BIND_IP=0.0.0.0`、UFW、云安全组 |
| 场景保存失败 | `ls -ld /opt/pv-ac-sim/scenarios` 与 `.env` 中 APP_UID/APP_GID 是否对应 |

不要在共享服务器执行 `docker system prune -a`，它可能删除回滚所需镜像。

## 26. 安全注意事项

- 当前服务是 HTTP，未配置 HTTPS。
- 场景 API 当前无认证；公网可访问者可能读写/删除场景。
- `SERVER_SSH_KEY`、GHCR classic PAT、Docker 组权限都需要严格保护。
- Token 到期前应轮换：创建新 Token → 服务器重新 docker login → 验证 pull → 吊销旧 Token。
- 发布脚本自动回滚应用镜像，但不自动回滚场景数据。
- 将来应优先增加 HTTPS 反向代理、场景 API 认证、异地备份、监控告警和 E2E 测试。

官方参考：[GitHub Actions 发布 Packages](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions)、[GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)、[GitHub Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)。
