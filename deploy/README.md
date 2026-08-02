# 生产部署运维速查

> 完整流程见 [`../CICD持续集成部署.md`](../CICD持续集成部署.md)。
>
> 当前模式：GitHub Actions 构建并推送 GHCR 镜像；服务器只 pull 不可变 digest 并运行容器。

## 当前运行信息

| 项目 | 当前值 |
|---|---|
| 容器 | `pv-ac-sim-web` |
| 镜像来源 | `ghcr.io/<owner>/photovoltaic-air-conditioner@sha256:...` |
| 容器端口 | `8080` |
| 公网端口 | `8765` |
| 健康检查 | `/health` |
| 场景目录 | `/opt/pv-ac-sim/scenarios` |
| 当前 Tag/digest | `/opt/pv-ac-sim/current-release`、`current-image` |
| 回滚元数据 | `/opt/pv-ac-sim/deploy/versions/<tag>/` |

## 查看状态与日志

```bash
ssh -p 22 user@SERVER_IP
cd /opt/pv-ac-sim
cat current-release
cat current-image
docker ps --filter name=pv-ac-sim-web
docker inspect --format='{{.State.Health.Status}}' pv-ac-sim-web
curl --fail http://127.0.0.1:8765/health
docker logs --tail 100 pv-ac-sim-web
docker stats --no-stream pv-ac-sim-web
```

## 日常发布

```bash
git checkout main
git pull --ff-only origin main
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

GitHub Actions 会构建、测试、推送 GHCR 镜像，然后让服务器 pull 指定 digest。服务器不会构建镜像。不要执行 `git push --tags`。

## 手动回滚

```bash
cd /opt/pv-ac-sim
./deploy/deploy.sh v0.1.0
```

脚本从 `deploy/versions/v0.1.0/` 读取保存的 digest 与 Compose 快照，pull 后启动旧版本。应用回滚不回滚场景数据。

## 场景备份

```bash
cd /opt/pv-ac-sim
backup="/tmp/pv-ac-scenarios-$(date +%Y%m%d-%H%M%S).tar.gz"
tar --exclude='scenarios/*.tmp' -czf "$backup" scenarios/
ls -lh "$backup"
```

部署前自动备份仅保留最近 10 份且与服务器同机；重要场景应复制到异地。

## 常见故障

GHCR 拉取失败：

```bash
docker logout ghcr.io
printf '%s' 'GHCR_READ_TOKEN' | docker login ghcr.io -u GITHUB_USERNAME --password-stdin
docker pull "$(cat /opt/pv-ac-sim/current-image)"
```

容器 unhealthy：

```bash
docker ps -a --filter name=pv-ac-sim-web
docker logs --tail 200 pv-ac-sim-web
curl -v http://127.0.0.1:8765/health
```

场景无法保存：

```bash
ls -ld /opt/pv-ac-sim/scenarios
grep -E '^(APP_UID|APP_GID)=' /opt/pv-ac-sim/.env
```

公网不可访问：检查 `WEB_BIND_IP=0.0.0.0`、Docker 端口映射、服务器防火墙和云安全组的 `8765/tcp`。
