# 生产部署运维速查

> 完整流程见 [`../CICD持续集成部署.md`](../CICD持续集成部署.md)。
>
> 当前模式：GitHub Actions 构建并推送 GHCR 镜像；服务器只 pull 不可变 digest 并运行容器。
>
> GHCR 的 `vX.Y.Z` 供人识别，服务器按 `@sha256:...` 部署以保证镜像不可变；`current-release` 与 `current-image` 保存两者对应关系。

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

成功标准：Release 全绿、`current-release` 为本次 Tag、`current-image` 为本次 digest、`docker inspect --format='{{.State.Health.Status}}' pv-ac-sim-web` 输出 `healthy`。

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
docker inspect --format='{{range .State.Health.Log}}{{printf "开始=%s exit=%d 输出=%q\n" .Start .ExitCode .Output}}{{end}}' pv-ac-sim-web
docker exec pv-ac-sim-web wget -S -O- http://127.0.0.1:8080/health
curl -v http://127.0.0.1:8765/health
```

健康检查固定使用 IPv4 回环地址 `127.0.0.1`；不要改成可能解析为 IPv6 `::1` 的 `localhost`。

场景无法保存：

```bash
ls -ld /opt/pv-ac-sim/scenarios
grep -E '^(APP_UID|APP_GID)=' /opt/pv-ac-sim/.env
```

公网不可访问：检查 `WEB_BIND_IP=0.0.0.0`、Docker 端口映射、服务器防火墙和云安全组的 `8765/tcp`。

## 镜像保留与清理

旧容器被替换后，Docker 默认不会删除旧镜像；当前部署脚本也主动保留旧镜像，方便快速回滚。用下面命令查看空间与版本映射：

```bash
docker system df
cat /opt/pv-ac-sim/current-release
cat /opt/pv-ac-sim/current-image
find /opt/pv-ac-sim/deploy/versions -maxdepth 2 -type f -print
```

仅在磁盘空间紧张并确认旧版本不再需要时，按明确 digest 删除单个旧镜像。不要在共享服务器执行 `docker system prune -a`。
