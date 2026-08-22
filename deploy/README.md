# Kubernetes 生产发布运维速查

> 当前生效模式：GitHub Actions 校验源码、构建镜像并推送 GHCR；不再通过 SCP/SSH 自动部署。生产更新由运维人员在 Kubernetes 服务器手动执行。
>
> 原 Docker Compose 部署脚本 [`deploy.sh`](./deploy.sh) 暂时保留，但当前 Release 不再调用。

## GitHub 发布镜像

在本地确保 `main` 已经通过 CI，然后创建新的唯一版本 Tag：

```bash
git checkout main
git pull --ff-only origin main
git tag -a v0.2.3 -m "Release v0.2.3"
git push origin v0.2.3
```

GitHub Actions 的 Release 工作流依次执行：

```text
verify → publish-image
```

`publish-image` 绿色即表示 GHCR 已生成：

```text
ghcr.io/mike666wq/photovoltaic-air-conditioner:v0.2.3
```

正式版同时更新 `latest`，但 Kubernetes 手动更新应使用本次唯一版本 Tag，确保 `kubectl set image` 一定产生新的 Deployment 修订版本。

## Kubernetes 手动滚动更新

登录 Kubernetes 服务器后执行，将版本号替换为刚发布成功的 Tag：

```bash
kubectl -n cloud set image deployment/pv-ac-sim-web \
  pv-ac-sim-web=ghcr.io/mike666wq/photovoltaic-air-conditioner:v0.2.3

kubectl -n cloud rollout status deployment/pv-ac-sim-web --timeout=5m
```

`rollout status` 显示 `successfully rolled out` 即更新完成。再检查：

```bash
kubectl -n cloud get deployment pv-ac-sim-web
kubectl -n cloud get pods -l app=pv-ac-sim-web -o wide
kubectl -n cloud get service pv-ac-sim-web
```

## 查看当前镜像与日志

```bash
kubectl -n cloud get deployment pv-ac-sim-web \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="pv-ac-sim-web")].image}{"\n"}'

kubectl -n cloud logs deployment/pv-ac-sim-web --tail=200
kubectl -n cloud describe deployment pv-ac-sim-web
```

## 一行回滚

回滚到上一 Deployment 修订版本：

```bash
kubectl -n cloud rollout undo deployment/pv-ac-sim-web
```

随后必须确认回滚完成：

```bash
kubectl -n cloud rollout status deployment/pv-ac-sim-web --timeout=5m
```

查看历史或回滚到指定修订版本：

```bash
kubectl -n cloud rollout history deployment/pv-ac-sim-web
kubectl -n cloud rollout undo deployment/pv-ac-sim-web --to-revision=2
```

## 当前 CI/CD 边界

| 环节 | 当前方式 |
|---|---|
| PR/main 检查 | GitHub Actions 自动执行 |
| Docker 镜像构建 | GitHub Actions 自动执行 |
| GHCR 镜像发布 | 推送版本 Tag 后自动执行 |
| Kubernetes 拉取新镜像 | 手动执行 `kubectl set image` 后由 Kubernetes 完成 |
| 滚动更新检查 | 手动执行 `kubectl rollout status` |
| 回滚 | 手动执行 `kubectl rollout undo` |
