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

入口 `/bms/manage`（实时页顶部“设备注册与接入”），包括首次管理员初始化、设备注册、观看账户创建、令牌轮换、设备删除，以及 Windows 本地接入指南。模块仍默认关闭，不内置生产账户，也不开放匿名自动注册。

推荐网页注册流程：

1. 运维配置**独立可写持久卷**和随机初始化密钥文件，启用下面的环境变量。密钥通过安全方式交给站点持有者，不贴在聊天或日志。
2. 站点持有者打开 `/bms/manage`，输入初始化密钥、自选管理员用户名和至少12位密码。只允许创建首个管理员一次，之后初始化接口关闭；无需先有观看账户。
3. 管理员登录并注册设备：复制 Windows 客户端稳定的 `deviceId`，填写名称、实际 BMS 地址（1–255）和 Pack（1–16）；真实设备保持“允许模拟数据”未勾选。
4. 下载页面生成的 **Windows 配置说明（含令牌）**，将根地址、设备编号、上传令牌填入本地客户端。下载内容是操作说明，不是已承诺可被客户端自动导入的配置格式。令牌关闭后无法再读取，丢失时通过页面轮换；旧令牌立即失效，现有观看结束，需要更新本地令牌再连接。
5. 在同页创建观看账户并选择授权设备，安全交付用户名和初始密码。管理员也可观看。观看账户不能注册设备、创建账户或生成令牌。
6. Windows 先确认 COM、波特率等按仪器说明配置且读到真实数据，再开启云连接。网页 `/bms/realtime` 登录、选择设备/Pack、点击连接；待下一次心跳领取租约后上传。网页不能启动远程 EXE 或串口。

注册结果保存于 `BMS_REALTIME_REGISTRY_DIR/registry.json`：随机salt+scrypt密码散列、SHA-256设备令牌散列与权限。写入通过串行队列、0600临时文件、fsync、原子重命名实现，落盘成功后更新内存；重启恢复账户和设备，但不恢复登录、租约或短趋势。注册目录必须独立于公开 `dist` 和 `scenarios`；本模块启动会拒绝这些目录。备份这个文件时按私密凭据管理，不能提交仓库。

接口：公开只读 `GET /api/realtime/setup/status` 返回是否启用、是否初始化及服务根地址；关闭模块时这个状态接口仍为200，其余模块接口503。`POST /setup/bootstrap` 须初始化密钥、同源Cookie/CSRF；`GET /admin/registry`、`POST /admin/devices`、`POST /admin/users`、`POST /admin/devices/:deviceId/token` 均须管理员会话，写操作须同源CSRF。读取注册列表不返回令牌或散列；设备注册/轮换响应仅向管理员一次性返回新令牌。令牌不进入localStorage或Vite环境变量。管理员可 `DELETE /admin/devices/:deviceId`（正文 `confirmDeviceId`，同源CSRF）删除设备；删除会持久移除设备及所有用户对应授权，并撤销令牌、结束观看、清除运行态，不删除本地记录。同编号重新注册不会自动恢复旧观看用户权限。

旧 CLI `admin.mjs`、`BMS_DEVICES_FILE` / `BMS_VIEWER_CREDENTIALS_FILE` 仍兼容：只设置旧文件时注册页面只读；同时配置空注册目录时首次从旧文件加载，第一次网页修改后写入新注册存储，以后以持久文件为准。已有观看角色不会自动升级管理员；迁移前需确认旧配置含管理员。不要覆盖已有文件或删除持久卷来“重新初始化”。

Cookie包含HttpOnly、Secure、SameSite=Strict；所有浏览器写操作检查固定PUBLIC_ORIGIN及X-Bms-Csrf。普通观看浏览器不获取设备token；管理员仅在生成时获取一次性token；读取接口不返回密码散列或服务端文件路径。生产NODE_ENV设为production，开发HTTP例外不会在生产启用。

### 必需环境与资源边界

```text
BMS_REALTIME_ENABLED=1
BMS_REALTIME_REGISTRY_DIR=/app/bms-registry
BMS_REALTIME_BOOTSTRAP_TOKEN_FILE=/run/bms-bootstrap/token
BMS_REALTIME_PUBLIC_ORIGIN=https://pv-ac.bbben.xyz
BMS_REALTIME_CACHE_TTL_SECONDS=600
BMS_REALTIME_MAX_POINTS=600
BMS_REALTIME_VIEWER_TTL_SECONDS=45
BMS_REALTIME_MAX_DEVICES=20
BMS_REALTIME_MAX_VIEWERS_PER_USER=4
```

初始化密钥是外部Secret；注册目录是独立可写持久卷，两者不进入镜像或Vite环境变量。观看用户格式为 `{users:[{username,passwordHash,devices:[deviceId],role:"viewer"}]}`。设备格式为 `{devices:[{deviceId,alias,allowedPacks,allowedAddresses,deviceTokenHash,allowSimulation:false,displayTimeZone:"Asia/Shanghai"}]}`。真实设备默认禁止simulation来源。

每Pack同时受600点和10分钟限制，最新值10分钟淘汰，趋势只存总压/电流/SOC；最后观看者退出清短趋势。超时/重复包不做无限历史补传。数值百分比超出0–100保留并标注；告警false/null表示未知。新鲜度窗口取max(15秒,3×periodSeconds)，受10分钟缓存上限约束，周期未知取45秒；心跳超过45秒标离线，心跳不能证明串口/采集状态。湿度0提示可能未接传感器。

设备正文限64KiB，含chunked累计；正文读取超时4秒，客户端请求上限5秒。单设备heartbeat30次/分钟、snapshot1800次/分钟；每观看用户最多4租约/4条SSE，浏览器请求600次/分钟。登录每连接来源10次/分钟，散列验证最多4个并行；无用户枚举错误。反向代理后连接来源可能是同一入口地址，应在实际Ingress另设合理登录限流。SSE Node写缓冲超过64KiB关闭连接；租约、会话、退役信息、去重和缓存均有界。

### 部署模式与Ingress

**当前实现仅支持单Node进程、单副本、Recreate发布。** 注册散列保存在独立PVC，初始化密钥保存在Secret，短缓存/租约在内存；进程重启会清空缓存和登录会话，需重新登录/创建观看，客户端重新领租约。普通RollingUpdate即使replicas=1也可能同时存在两个状态实例，不能使用；浏览器粘性不能保证设备POST也落到同实例。多副本/无停机发布需先实现Redis等共享租约、缓存、去重和发布订阅。

运维确认现有Deployment后，将replicas设为1、strategy设为Recreate，挂载独立可写注册PVC与只读初始化密钥Secret并设置上述环境。Docker仍以非root node用户提供8080及/health，运行镜像只复制必需实时模块。现有HTTPS入口须直接转发 `/api/realtime/*`，不附加斜杠、不跳登录页；内部Node可HTTP，Windows只使用受信任证书的外部HTTPS。

SSE使用text/event-stream、no-cache/no-store、X-Accel-Buffering:no，每15秒注释keepalive。实际Ingress需禁缓冲、禁缓存，read timeout高于心跳间隔（可先评估90秒）；具体annotation取决于实际控制器，不直接假设Nginx。本轮注册上线需配置上述PVC与初始化密钥Secret；Ingress是否兼容仍以实际联调为准。

### Kubernetes 网页注册首次启用

当前集群有 `local-path` StorageClass；其他集群请先核对 `kubectl get storageclass`，不要盲目沿用。独立PVC示例：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pv-ac-bms-registry
  namespace: cloud
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  resources:
    requests:
      storage: 1Gi
```

在安全目录生成32随机字节的初始化密钥并创建Secret（文件权限0600，命令不打印内容）：

```bash
# /安全目录需由管理员预先创建，权限0700；不在仓库里。
node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; writeFileSync("/安全目录/bootstrap-token.txt", randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });'
kubectl -n cloud create secret generic pv-ac-bms-bootstrap \
  --from-file=token=/安全目录/bootstrap-token.txt
```

将上述环境变量加入**现有容器**，同时在现有 Pod 模板增补以下卷和挂载，保留场景卷、资源约束与其他配置。不能把下面片段当作完整Deployment覆盖现有部署。

```yaml
# spec.template.spec.volumes 增补
- name: bms-registry
  persistentVolumeClaim:
    claimName: pv-ac-bms-registry
- name: bms-bootstrap
  secret:
    secretName: pv-ac-bms-bootstrap
    defaultMode: 0400
# 现有 pv-ac-sim-web 容器 volumeMounts 增补
- name: bms-registry
  mountPath: /app/bms-registry
- name: bms-bootstrap
  mountPath: /run/bms-bootstrap
  readOnly: true
```

上面0400密钥权限适用于当前Kubernetes容器UID 0；Docker默认USER为node。若部署调整成非root，需一起安排Secret读权限和PVC写权限（例如受控fsGroup及0440），不能只复制挂载片段。镜像、环境、卷和挂载应在同一次Pod模板更新里生效，旧版本不支持空目录网页初始化。发布维持单副本Recreate。

确认 Pod 就绪、PVC Bound；访问 `/api/realtime/setup/status` 应为 enabled=true、initialized=false、writable=true、bootstrapAvailable=true。接着由站点持有者自行填写首个管理员密码，不由运维在公开终端或聊天中代填。初始化后密钥不再能创建第二个管理员；移除密钥挂载时也须同时移除TOKEN_FILE环境变量。持久卷应备份并考虑设置PV回收策略Retain；回滚镜像/关闭模块时保留注册PVC。

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

本次本机验收：32个Vitest文件、168项测试；21项Node协议/状态/SSE/注册测试；类型检查及生产构建通过。浏览器验证未观看/离线/等待采样、模拟标识、53.31V/−1.02A/88.78Ah、负温度、三个独立单位趋势、缩放后新采样不重置观察窗口、返回最新、390px无横向溢出及断开后无上传租约。另用生产serve-prod验证SPA/API/health。本机未安装Docker，镜像构建留待CI确认。此处是生成夹具验收，**尚无Windows真实客户端与正式HTTPS成功联调证据**。

联调时回传：实际HTTPS根地址、注册deviceId及address/Pack、安全交付设备token的方式、观看登录方式、API v1响应样例、单副本/Recreate与Ingress配置、Windows回归结果。不要把设备token贴到聊天或公开日志。上线前完成这项联合验收；失败时可将BMS_REALTIME_ENABLED改为0关闭模块，或回滚镜像，原有页面仍可使用。

### 账户与登录状态保存位置

当前未接入SQLite/PostgreSQL等数据库。账户、scrypt密码散列、设备令牌SHA-256散列及设备授权存于服务器独立PVC上的 `registry.json`，仅服务器运行用户读写；浏览器没有密码散列，也不通过localStorage保存认证令牌。普通观看账户由管理员创建，不开放自助注册或默认授权实验设备。

登录会话是服务器内存Map：随机会话ID对应用户与CSRF nonce，最长8小时。浏览器持有HttpOnly/Secure/SameSite=Strict Cookie，Cookie内容仅会话ID；每个API请求在服务器校验会话与当前设备权限。登录时更换会话ID，退出时撤销服务器会话及观看。服务重启保留账户、清除会话，用户需重新登录。这是文件持久化注册加服务器会话实现，不能称为已接入账户数据库。
