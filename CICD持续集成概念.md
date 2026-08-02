# CI/CD 概念说明

> 本文解释当前项目的发布模型；可逐步执行的命令见 [`CICD持续集成部署.md`](./CICD持续集成部署.md)。

## 本项目的实际流水线

```text
本地：Git 管理源码并推送 GitHub
  → GitHub CI：typecheck、Vite build、Docker 容器冒烟测试
  → 在 main 上推送 vX.Y.Z Tag
  → GitHub Actions 构建镜像并推送 GHCR
  → 服务器 pull 不可变 sha256 digest
  → Docker Compose 启动容器、健康检查
  → 失败时恢复上一版本 digest
```

## CI 与 CD 的职责

- **CI（持续集成）**：PR 合并到 `main` 前或推送到 `main` 后，自动检查类型、构建结果与生产容器的核心 HTTP/场景接口。
- **CD（持续部署）**：发布 Tag 后，自动将已构建镜像发布到 GHCR，并让服务器拉取并运行该镜像。

## 关键原则

- 本地不需要 Docker，也不在本地构建生产镜像。
- GitHub Actions 是镜像唯一构建位置；镜像推送到 GHCR。
- 服务器只需要 Docker/Docker Compose 和 GHCR 拉取权限；不安装 Node、pnpm、Git 或项目源码。
- 服务器运行的是 `ghcr.io/...@sha256:...`，而非可变 Tag，确保部署内容不可被覆盖。
- `scenarios/` 是宿主机持久化数据，不属于镜像，必须独立备份。
- 服务器同步的仅是 Compose 与部署脚本配置，不是应用源码。

## 当前边界

- 公网入口为 `http://SERVER_IP:8765/`，尚未配置 HTTPS。
- 场景 API 当前没有认证，公网部署前需要评估未授权读写风险。
- 当前是单容器原地替换，可能短暂中断，不保证零停机。
