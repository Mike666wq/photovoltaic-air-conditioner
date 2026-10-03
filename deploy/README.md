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

## BMS独立实时模块（v1，2026-10-03）

入口 `/bms/realtime`，独立懒加载。原理图和数据分析均有导航入口。这个页面只管理观看、接收快照和展示10分钟内短趋势，不打开实验机串口、调整采集间隔、导出本地记录或控制充放电。状态隔离在 `bmsRealtime` store，不写入原仿真/文件回放管线。

### 协议与接口

Windows客户端继续使用域名根 `https://pv-ac.bbben.xyz`，设备Bearer只用于：

- `POST /api/realtime/heartbeat`，完整返回 `subscriptionId`、`leaseSeconds`、`requestedPacks`；没有观看者返回空ID/0/空数组。
- `POST /api/realtime/snapshots`，正文为 `{subscriptionId,snapshot}`；v1接受缓存完成或幂等重复后返回 `200 {"accepted":true}`。

字段名称、大小写与单位沿用交接v1。总压、电流、Ah除100；电芯保持mV；温度保持℃；电流仅标正负；原始告警尚未解码。允许缺失/null的periodSeconds。所有时间以Asia/Shanghai显示；receivedAt用于判断链路新鲜度，租约使用服务端单调时钟。

浏览器通过独立观看会话调用auth/session、auth/login、auth/logout、devices、viewers POST/PUT/DELETE、latest、trend和events；管理员可DELETE设备cache。观看TTL45秒，正常15秒续期。设备心跳常规15秒，设备上传租约最大45秒。多观看者Pack取并集；最后观看者退出立即撤销服务端上传授权。页面隐藏会停止观看，回到页面需重新点击连接。EventSource重连走最新值bootstrap，不承诺全量历史回放。

同设备另一个connectionSessionId在原会话最近45秒内仍上传时返回 `409 SESSION_CONFLICT`；允许切换后，旧会话在有限退役窗口中返回 `409 SESSION_RETIRED`。本地重连换会话可能需要等待原会话失效，界面不可让两个采集机同时使用同一deviceId。该规则保留v1结构，无需新增客户端字段。

### 注册与凭据

模块默认关闭。没有匿名设备写入、自动设备注册或内置生产账户。生产启用前管理员核对客户端deviceId、实际address及允许Pack，注册文件通过Secret/安全挂载提供。

仓库提供首次初始化工具；观看密码从stdin读入，设备令牌写入权限0600文件，控制台不会打印令牌。不要将密码作为CLI参数。

```bash
# 在管理员安全终端中输入密码；生成目录必须位于仓库之外。
read -r -s bms_password
printf '%s' "$bms_password" | node apps/web/scripts/realtime/admin.mjs \
  --dir /安全目录/bms-registration --device lab-bms-01 \
  --packs 1 --addresses 1 --user observer
unset bms_password
```

输出 `devices.json`（token SHA-256）、`viewers.json`（随机salt+scrypt密码散列）、`device-token.txt`（仅交给本地客户端）。默认观看角色viewer；`--admin`才允许清缓存。工具拒绝覆盖已有文件；后续增删用户/轮换令牌由管理员修改并重新挂载注册文件，重启服务生效。设备注册支持allowedAddresses，缺省只允许地址1，最多注册16个地址，每个地址1–255。别名不参与身份验证。token由32随机字节生成。

Cookie包含HttpOnly、Secure、SameSite=Strict；所有浏览器写操作检查固定PUBLIC_ORIGIN及X-Bms-Csrf。浏览器不获取设备token、密码散列或服务端文件路径。生产NODE_ENV设为production，开发HTTP例外不会在生产启用。

### 必需环境与资源边界

```text
BMS_REALTIME_ENABLED=1
BMS_DEVICES_FILE=/run/bms/devices.json
BMS_VIEWER_CREDENTIALS_FILE=/run/bms/viewers.json
BMS_REALTIME_PUBLIC_ORIGIN=https://pv-ac.bbben.xyz
BMS_REALTIME_CACHE_TTL_SECONDS=600
BMS_REALTIME_MAX_POINTS=600
BMS_REALTIME_VIEWER_TTL_SECONDS=45
BMS_REALTIME_MAX_DEVICES=20
BMS_REALTIME_MAX_VIEWERS_PER_USER=4
```

注册文件是外部配置，不进入镜像或Vite环境变量。观看用户格式为 `{users:[{username,passwordHash,devices:[deviceId],role:"viewer"}]}`。设备格式为 `{devices:[{deviceId,alias,allowedPacks,allowedAddresses,deviceTokenHash,allowSimulation:false,displayTimeZone:"Asia/Shanghai"}]}`。真实设备默认禁止simulation来源。

每Pack同时受600点和10分钟限制，最新值10分钟淘汰，趋势只存总压/电流/SOC；最后观看者退出清短趋势。超时/重复包不做无限历史补传。数值百分比超出0–100保留并标注；告警false/null表示未知。新鲜度窗口取max(15秒,3×periodSeconds)，受10分钟缓存上限约束，周期未知取45秒；心跳超过45秒标离线，心跳不能证明串口/采集状态。湿度0提示可能未接传感器。

设备正文限64KiB，含chunked累计；正文读取超时4秒，客户端请求上限5秒。单设备heartbeat30次/分钟、snapshot1800次/分钟；每观看用户最多4租约/4条SSE，浏览器请求600次/分钟。登录每连接来源10次/分钟，散列验证最多4个并行；无用户枚举错误。反向代理后连接来源可能是同一入口地址，应在实际Ingress另设合理登录限流。SSE Node写缓冲超过64KiB关闭连接；租约、会话、退役信息、去重和缓存均有界。

### 部署模式与Ingress

**当前实现仅支持单Node进程、单副本、Recreate发布。** 注册凭据保存在Secret，短缓存/租约在内存；进程重启会清空缓存和登录会话，需重新登录/创建观看，客户端重新领租约。普通RollingUpdate即使replicas=1也可能同时存在两个状态实例，不能使用；浏览器粘性不能保证设备POST也落到同实例。多副本/无停机发布需先实现Redis等共享租约、缓存、去重和发布订阅。

运维确认现有Deployment后，将replicas设为1、strategy设为Recreate，挂载只读注册Secret并设置上述环境。Docker仍以非root node用户提供8080及/health，运行镜像只复制必需实时模块。现有HTTPS入口须直接转发 `/api/realtime/*`，不附加斜杠、不跳登录页；内部Node可HTTP，Windows只使用受信任证书的外部HTTPS。

SSE使用text/event-stream、no-cache/no-store、X-Accel-Buffering:no，每15秒注释keepalive。实际Ingress需禁缓冲、禁缓存，read timeout高于心跳间隔（可先评估90秒）；具体annotation取决于实际控制器，不直接假设Nginx。没有在本次开发中修改服务器、生产凭据或Ingress。

### 开发与验收

开发、preview和生产共用 `scripts/realtime/routes.mjs`。在隔离本机环境使用外部生成配置；如需本机HTTP验证，另设 `BMS_REALTIME_DEV_HTTP=1`、PUBLIC_ORIGIN为明确的localhost/127.0.0.1地址，并且NODE_ENV不能为production。该例外只用于开发，不改Windows客户端HTTPS/证书检查。

```bash
cd apps/web
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
node --test scripts/realtime/*.test.mjs
./node_modules/.bin/vite build
node scripts/copy-svgs.mjs
# 环境配置好后启动生产脚本，或用vite进行开发
PORT=8080 node scripts/serve-prod.mjs
```

协议夹具位于 `apps/web/scripts/realtime/fixtures/snapshot-v1.json`，明确为接口示例；测试不读取忽略的data/文件。Node测试用动态loopback端口，Vitest仅收集src测试；两者均已加入CI/release verify。

本次本机验收：31个Vitest文件、166项测试；12项Node协议/状态/SSE测试；类型检查及生产构建通过。浏览器验证未观看/离线/等待采样、模拟标识、53.31V/−1.02A/88.78Ah、负温度、三个独立单位趋势、缩放后新采样不重置观察窗口、返回最新、390px无横向溢出及断开后无上传租约。另用生产serve-prod验证SPA/API/health。本机未安装Docker，镜像构建留待CI确认。此处是生成夹具验收，**尚无Windows真实客户端与正式HTTPS成功联调证据**。

联调时回传：实际HTTPS根地址、注册deviceId及address/Pack、安全交付设备token的方式、观看登录方式、API v1响应样例、单副本/Recreate与Ingress配置、Windows回归结果。不要把设备token贴到聊天或公开日志。上线前完成这项联合验收；失败时可将BMS_REALTIME_ENABLED改为0关闭模块，或回滚镜像，原有页面仍可使用。
