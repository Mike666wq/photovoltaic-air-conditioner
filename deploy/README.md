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

## 统一本地监控模块（BMS v1 + 实验 v1，2026-10-04）

页面入口为 `/monitoring`（统一只读主页）、`/bms/realtime`（BMS 实时视图）、`/experiment/realtime`（实验实时视图）和 `/monitoring/manage`（管理与接入，兼容别名 `/bms/manage`）。统一主页可绑定一个 BMS 设备和一个实验设备，两者都可暂不绑定。两个数据源各自保留协议、单位、样本和短趋势，只读显示；不打开本地串口、不调整采集、不导出本地历史，也不控制 PLC 或充放电。前端状态分别隔离在 `bmsRealtime` 与 `experimentRealtime`，不进入仿真、分析或文件回放管线。

### 协议与接口

Windows客户端继续使用域名根 `https://pv-ac.bbben.xyz`，设备Bearer只用于：

- `POST /api/realtime/heartbeat`，完整返回 `subscriptionId`、`leaseSeconds`、`requestedPacks`；没有观看者返回空ID/0/空数组。
- `POST /api/realtime/snapshots`，正文为 `{subscriptionId,snapshot}`；v1接受缓存完成或幂等重复后返回 `200 {"accepted":true}`。

字段名称、大小写与单位沿用交接v1。总压、电流、Ah除100；电芯保持mV；温度保持℃；电流仅标正负；原始告警尚未解码。允许缺失/null的periodSeconds。所有时间以Asia/Shanghai显示；receivedAt用于判断链路新鲜度，租约使用服务端单调时钟。

浏览器通过独立观看会话调用auth/session、auth/login、auth/logout、devices、viewers POST/PUT/DELETE、latest、trend和events；管理员可DELETE设备cache。BMS与实验页面共用45秒观看租约（正常约15秒续期）和服务端单调时钟。设备心跳通常每15秒发送，只有有效观看者存在时服务端才签发最多45秒的上传租约；最后一个有效观看者退出后撤销上传授权。页面隐藏会暂停续租，先前正在观看的页面返回前台后自动恢复；用户手动暂停的页面不会自动恢复。EventSource断线会按有界退避重新申请租约，并通过游标读取缓存保留期内的历史；401/403会停止重试。统一主页面登录后默认同时观看两路；旧的独立实时页仍需用户手动开始观看。

趋势接口每次最多返回2000项并支持游标分页；保留时间为一小时，不再是旧文档中的每Pack 600点/10分钟。BMS保留总压、电流、SOC曲线；实验源按仪器、测点、来源和采集会话隔离逐点趋势。模拟与串口样本分开，不跨点插值伪造同步。

同设备另一个connectionSessionId在原会话最近45秒内仍上传时返回 `409 SESSION_CONFLICT`；允许切换后，旧会话在有限退役窗口中返回 `409 SESSION_RETIRED`。本地重连换会话可能需要等待原会话失效，界面不可让两个采集机同时使用同一deviceId。该规则保留v1结构，无需新增客户端字段。

### 实验采集源 v1

实验 Windows 客户端使用同一域名根与独立实验设备 Bearer，调用 `POST /api/experiment/heartbeat` 和 `POST /api/experiment/snapshots`。心跳返回 `subscriptionId`、`leaseSeconds` 与 `requestedDevices`；无人观看时租约为空。快照包含 `schemaVersion:1`、`module:"experiment"`、稳定 `deviceId`、连接/采集会话、序号、设备来源、仪器与逐点记录。服务端按共享有效观看租约验收上传，BMS 的 `/api/realtime/*` 路径与载荷保持原样。

正式仪器目录在 `apps/web/shared/experiment/point-contract.json`，列出37个注册测点。服务端校验仪器、测点、站号、零基地址、寄存器数量、单位、质量和时间；不自行增加点位或替客户端换算。`serial` 与 `simulation` 分开显示，模拟数据必须同时获得设备级和整体系统级许可。时间按点记录，逐台仪器并不构成同步采样轮次；网页只读，不会操作 PLC。Windows 配置下载是供人员手工填写的说明文件，不承诺客户端可导入格式。

两个实时模块共享一小时内存缓存与一个点数/估算字节数容量账本。BMS样本一小时后过期，实验测点以各自观测时间起算一小时。默认预算为500,000点、每点按1,024字节估算、总估算128MiB；超限时请求以503拒绝，当前快照、水位和趋势均不会部分提交。估算值用于容量保护，不等于Node进程RSS。观看租约到期或释放后，已有缓存仍保留到相应一小时期限；进程重启会丢失全部短缓存。

### 注册与凭据

入口 `/bms/manage`（页面标题“管理与接入”），包括首次管理员初始化、两类设备注册、系统名称与设备绑定、账户权限/状态管理、密码重置、令牌轮换和设备删除，以及 Windows 手动配置说明。模块仍默认关闭，不内置生产账户，也不开放匿名自动注册。

推荐网页注册流程：

1. 运维配置**独立可写持久卷**和随机初始化密钥文件，启用下面的环境变量。密钥通过安全方式交给站点持有者，不贴在聊天或日志。
2. 站点持有者打开 `/bms/manage`，输入初始化密钥、自选管理员用户名和至少12位密码。只允许创建首个管理员一次，之后初始化接口关闭；无需先有观看账户。
3. 管理员分别注册 BMS 或实验设备。BMS填写 Windows 客户端的稳定 `deviceId`、实际地址（1–255）和 Pack（1–16）；实验设备填写稳定 `deviceId` 并勾选获准仪器。是否允许模拟数据是设备级许可，实测设备保持关闭。
4. 在“本地监控系统设置”填写名称，可各绑定一台实验设备与BMS设备，也可留空；整体模拟许可与设备模拟许可必须同时开启。换绑前页面提示相关观看和短期历史将被清理，管理员可取消。
5. 下载页面生成的 **Windows 手动配置说明（含一次性令牌）**，由操作人员把域名根、设备编号和上传令牌手工填入相应客户端。它是说明文件，不保证客户端可导入。令牌关闭后不能再读取；丢失时轮换，旧令牌立即失效并结束观看。
6. 管理员可创建账户，单独授予设备、整体“本地监控”权限或两者。整体权限只可读取当前系统绑定源，不可管理设备或账户。管理员可修改观看账户权限、停用/恢复、重置他人密码；不能重置自己的密码。管理员与获准账户均通过登录会话观看。
7. Windows先确认仪器本地采集和记录正常，再按手动说明启用HTTPS云连接。浏览器进入 `/monitoring`、对应 `/bms/realtime` 或 `/experiment/realtime` 并明确开始观看；此时有效租约才会请求新采样上传。管理页状态检查是只读请求，不会替用户开始观看。心跳只证明客户端在线，不能当作串口实测点已到达；尚未完成真实Windows客户端和正式HTTPS联合验收。

注册结果保存于 `BMS_REALTIME_REGISTRY_DIR/registry.json`：随机salt+scrypt密码散列、SHA-256设备令牌散列、逐设备授权、整体监控权限和系统绑定。写入通过串行队列、0600临时文件、fsync、原子重命名实现，落盘成功后更新内存；重启恢复注册信息，但不恢复登录、租约或短趋势。注册目录必须独立于公开 `dist` 和 `scenarios`；本模块启动会拒绝这些目录。备份这个文件时按私密凭据管理，不能提交仓库。

当前注册存储兼容读取版本1和版本2；版本1缺少的系统设置与用户字段由运行时补默认值。**任何网页写操作都会以版本2格式写回**。版本2含系统绑定、设备模块、账户 `monitoringAccess` / `disabled` 等新字段，旧镜像未必能读取。升级前应停写并备份 `registry.json`（保留原文件权限并按凭据加密保管）；首次网页修改前另留一份版本1备份。回滚到只认版本1的旧镜像时，先停止Pod并把注册文件恢复成版本1备份，再启动旧镜像；`kubectl rollout undo` 只回滚镜像，不会回滚PVC数据。不要在仍运行的旧/新Pod间并发替换该文件。

接口：公开只读 `GET /api/realtime/setup/status` 返回模块状态；关闭模块时该状态仍为200，其余模块接口503。`POST /setup/bootstrap` 须初始化密钥、同源Cookie/CSRF；设备、账户注册和令牌轮换等写操作均须管理员会话及同源CSRF。读取注册列表不返回令牌或散列；设备注册/轮换响应仅向管理员一次性返回新令牌。令牌不进入localStorage或Vite环境变量。统一监控使用 `GET /api/monitoring/system`（管理员或获准整体观看用户）和 `GET/PUT /api/monitoring/admin/system`（仅管理员）。账户由管理员创建；可通过 `PUT /api/realtime/admin/users/:username` 设置整体监控权限与停用状态，通过 `POST /api/realtime/admin/users/:username/password` 重置他人密码；后端禁止自重置，前端不提供自重置入口。管理员可 `DELETE /api/realtime/admin/devices/:deviceId`（正文 `confirmDeviceId`）删除设备；删除解绑该设备、清理缓存与逐设备授权并结束观看，但保留账户的整体监控授权；本地记录不删除。同编号重新注册不会自动恢复旧逐设备授权。

旧 CLI `admin.mjs`、`BMS_DEVICES_FILE` / `BMS_VIEWER_CREDENTIALS_FILE` 仍兼容：只设置旧文件时注册页面只读；同时配置空注册目录时首次从旧文件加载，第一次网页修改后写入版本2注册存储，以后以持久文件为准。已有观看角色不会自动升级管理员或获得整体监控权限；迁移前需确认旧配置含管理员。不要覆盖已有文件或删除持久卷来“重新初始化”。

浏览器会话当前使用名为 `cloud_viewer` 的不透明Cookie，`Path=/api`、HttpOnly、生产环境Secure、SameSite=Strict；对应会话只存于服务端内存。旧BMS独立页面版本使用 `bms_viewer; Path=/api/realtime`，新版本不迁移或接受旧Cookie；升级后需重新登录，旧Cookie可能留在浏览器中直到过期。所有浏览器写操作检查固定PUBLIC_ORIGIN及X-Bms-Csrf。普通观看浏览器不获取设备token；管理员仅在生成时获取一次性token；读取接口不返回密码散列或服务端文件路径。生产NODE_ENV设为production，开发HTTP例外不会在生产启用。

### 必需环境与资源边界

```text
BMS_REALTIME_ENABLED=1
BMS_REALTIME_REGISTRY_DIR=/app/bms-registry
BMS_REALTIME_BOOTSTRAP_TOKEN_FILE=/run/bms-bootstrap/token
BMS_REALTIME_PUBLIC_ORIGIN=https://pv-ac.bbben.xyz
BMS_REALTIME_VIEWER_TTL_SECONDS=45
BMS_REALTIME_MAX_DEVICES=20
BMS_REALTIME_MAX_VIEWERS_PER_USER=4
BMS_REALTIME_BROWSER_REQUESTS_PER_MINUTE=5000
BMS_REALTIME_MAX_CACHE_POINTS=500000
BMS_REALTIME_MAX_CACHE_BYTES=134217728
```

初始化密钥是外部Secret；注册目录是独立可写持久卷，两者不进入镜像或Vite环境变量。`BMS_REALTIME_VIEWER_TTL_SECONDS` 当前最多允许45秒；两个模块共用。`BMS_REALTIME_MAX_VIEWERS_PER_USER=4`表示每账户最多4个活动页面，页面额度跨BMS与实验模块共享；同页可分别申请两模块各一条租约。最多10个账户可同时观看，每模块最多40条租约，每账户最多8条SSE。旧客户端未传`pageId`时，每条租约按独立页面计数。`BMS_REALTIME_BROWSER_REQUESTS_PER_MINUTE`按账户限流，默认5000次/分钟，可配置范围为1–10000。10个账户×4页双路共80条租约、约2800请求/分钟的生成负载测试已通过；这仅验证服务端限额处理，现场上传量与正式HTTPS联调仍待验收，不能用生成数据代替现场实测。`BMS_REALTIME_MAX_CACHE_POINTS` 默认500,000、可设范围1–5,000,000；`BMS_REALTIME_MAX_CACHE_BYTES` 默认134,217,728（128 MiB）、可设范围1–1,073,741,824（1 GiB），按每点1,024字节估算。缓存TTL在代码中固定为一小时，旧变量 `BMS_REALTIME_CACHE_TTL_SECONDS` 不再使用。

持久账户格式为 `{users:[{username,passwordHash,devices:[deviceId],role:"viewer",monitoringAccess:false,disabled:false}]}`；`devices` 可为空，整体监控授权仅可查看配置绑定设备。设备记录按模块保存BMS地址/Pack或实验仪器许可，并各自设置 `allowSimulation`。整体系统配置另存 `name`、`experimentDeviceId|null`、`bmsDeviceId|null` 与 `allowSimulation`；模拟数据必须通过整体及设备两层许可。真实设备默认禁止simulation来源。

BMS与实验测点共用一小时内存保留、有效观看租约协调器和全局容量预算。单条观测到期后从latest和趋势移除；无观看租约时客户端不上传，但已有短缓存仍在一小时期限内保留。趋势按每次最多2000项分页，缓存预算超限则返回503 `CACHE_CAPACITY_EXCEEDED`，当前请求不部分提交；容量数值为估算值，不是进程RSS硬限制。数值百分比超出0–100保留并标注；告警false/null表示未知。BMS新鲜度窗口取max(15秒,3×periodSeconds)，周期未知取45秒；心跳超过45秒标离线，但心跳不能证明串口/采集状态。湿度0提示可能未接传感器。

设备正文限64KiB，含chunked累计；正文读取超时4秒，客户端请求上限5秒。单设备heartbeat30次/分钟、snapshot1800次/分钟。每账户最多4个跨模块共享活动页面；同一页面最多在BMS和实验模块各持一条租约。最多10个账户同时观看，每模块最多40条租约、每账户最多8条SSE。旧客户端未带`pageId`时每条租约单独计为一个页面。浏览器请求按账户限流，默认5000次/分钟、最大可设10000次/分钟。登录每连接来源10次/分钟，散列验证最多4个并行；注册账户存量硬上限为100。阶段4 Node生成负载测试覆盖10账户×4页面双路80租约与约2800请求/分钟并通过；它不代表现场上传量或正式HTTPS已验收。反向代理后连接来源可能是同一入口地址，应在实际Ingress另设合理登录限流。SSE Node写缓冲超过64KiB关闭连接；租约、会话、退役信息、去重和缓存均有界。

### 部署模式与Ingress

**当前实现仅支持单Node进程、单副本、Recreate发布。** 注册散列保存在独立PVC，初始化密钥保存在Secret，短缓存/租约和登录会话在内存；进程重启会清空缓存、观看租约及服务器会话，用户需重新登录并开始观看，客户端重新领租约。新版浏览器会话使用 `cloud_viewer; Path=/api`，旧版 `bms_viewer; Path=/api/realtime` 不迁移，重启/升级后旧会话无效。普通RollingUpdate即使replicas=1也可能同时存在两个状态实例，不能使用；浏览器粘性不能保证设备POST也落到同实例。多副本/无停机发布需先实现Redis等共享租约、缓存、去重和发布订阅。

运维确认现有Deployment后，将replicas设为1、strategy设为Recreate，挂载独立可写注册PVC与只读初始化密钥Secret并设置上述环境。Docker仍以非root node用户提供8080及/health，运行镜像只复制必需实时模块。现有HTTPS入口须将 `/api/realtime/*`、`/api/experiment/*` 与 `/api/monitoring/*` 原样转发到同一Node实例；不得附加斜杠、改写路径或跳转登录页。内部Node可HTTP，Windows只使用受信任证书的外部HTTPS。

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

协议夹具位于 `apps/web/scripts/realtime/fixtures/snapshot-v1.json`，明确为接口示例；测试不读取忽略的 `data/` 文件。Node测试用动态loopback端口，Vitest收集 `src` 测试；CI/release需分别通过类型检查、前端测试、实时API测试与构建。

此前BMS v1的浏览器验收使用生成夹具，曾覆盖未观看/离线/等待采样、模拟标识、单位显示、短趋势和断开后无上传租约；其中显示的电压、电流、温度均为**测试夹具值，不是现场测量**。新增实验采集源、共享缓存和统一监控页不能继承为真实设备验收结论。当前文档记录不证明Windows客户端与正式HTTPS已成功联调，也不证明现场真实串口测点已到达；上线前需用真实Windows客户端完成联合验收。本机未安装Docker，镜像构建仍由CI确认。

联调时回传：实际HTTPS根地址、注册deviceId及address/Pack或仪器范围、安全交付设备token的方式、账户权限、观看登录方式、API响应样例、单副本/Recreate与Ingress配置、Windows本地和云端回归结果。不要把设备token贴到聊天或公开日志。上线前完成这项联合验收；失败时可将 `BMS_REALTIME_ENABLED=0` 关闭实时模块，或回滚镜像，原有页面仍可使用。

### 账户与登录状态保存位置

当前未接入SQLite/PostgreSQL等数据库。账户、scrypt密码散列、设备令牌SHA-256散列、设备级授权、整体 `monitoringAccess` 与 `disabled` 状态存于服务器独立PVC上的 `registry.json`，仅服务器运行用户读写；浏览器没有密码散列，也不通过localStorage保存认证令牌。观看账户由管理员创建，可只有整体绑定源权限、只有指定设备权限、同时拥有两者，或停用；管理员不能禁用管理员账户。注册账户存量硬上限为100；同时观看账户上限为10。阶段4生成负载测试已覆盖该并发配额，但现场真实上传量与正式HTTPS仍待验收。

登录会话是服务器内存Map：随机会话ID对应用户与CSRF nonce，最长8小时。浏览器持有HttpOnly/Secure/SameSite=Strict Cookie，Cookie内容仅会话ID；每个API请求在服务器校验会话与当前设备权限。登录时更换会话ID，退出时撤销服务器会话及观看。服务重启保留账户、清除会话，用户需重新登录。这是文件持久化注册加服务器会话实现，不能称为已接入账户数据库。
