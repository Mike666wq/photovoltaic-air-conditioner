# 光伏·空调监控客户端安装与验收

客户端联网打开 https://pv-ac.bbben.xyz/monitoring，保留全部站内功能。它不负责采集仪器数据，不提供离线监控。客户端版本在“关于”查看，云端版本在网页页眉查看。

## 下载与校验

试装文件来自 GitHub Actions 的 Client Packages 工作流 `client-installers` 产物。正式客户端通过 `client-vX.Y.Z` 独立标签发布，不更新 Kubernetes 或云端镜像。下载 APK、Windows 安装 EXE 和 SHA256SUMS.txt 后核对校验值。

Android 支持 Android 10+，需允许从所选下载应用安装 APK；Windows 支持 Windows 10/11 x64。Windows 首版没有商业代码签名，可能显示未知发布者或 SmartScreen 提示。请核对下载来源与文件校验，勿关闭系统安全保护。

## 安装、升级与登录

Android 后续升级必须使用同一长期签名密钥和更大的 versionCode。Windows 按当前用户安装，开始菜单入口自动创建，桌面图标可选。缺少 WebView2 Evergreen Runtime 时安装程序引导至微软官方页面；运行时未装好前不能打开网页。Windows 不需单独安装 .NET。

升级保留应用会话与配置。Windows 卸载清除此应用的当前用户配置，用户主动保存的文件不删除。Android 卸载由系统清除应用私有数据。

登录沿用服务端固定8小时会话，不存密码；服务器发布重启、停用账户或撤销会话后需重新登录。关闭客户端不会延长登录期限。

## 两端真机验收（正式发布前）

- 首装、再次启动、覆盖升级；Windows卸载后重装清除会话；两端“关于”与文件版本正确。
- 登录、退出、会话过期与权限撤销；监控列表、真实设备SSE更新及断网重连。
- Android切后台、Windows最小化暂停观看；Windows仅失焦仍更新。回前台恢复监控，回放停在原帧等待手动继续。
- 返回先关闭最上层弹窗/抽屉，再后退，最终确认退出；刷新和回到监控先提醒可能丢失数据。
- CSV/XLS/XLSX/PDF多文件选择、取消；设备配置说明的保存、取消和失败重试，保存后文件内容完整，令牌不出现在日志。
- Android横竖屏切换保留网页、数据与回放进度；HTTPS剪贴板复制、手机布局和原理图手势。
- 站内导航、站外浏览器链接及证书错误拒绝；主页面加载失败显示重试，已加载页面断网不自动整页重载。

只有构建与上述真机验收均通过后才发布正式标签。云端必须先部署含客户端网页适配的版本，方可验证文件保存、后台暂停与返回优先级；旧网页不支持完整客户端桥接行为。

## 构建与签名管理

Android构建使用JDK17、Gradle8.11.1、SDK35。Windows使用.NET8与Inno Setup6。工具版本在客户端工程及工作流中固定。请另外备份签名目录到离线加密存储，密钥位置不放入公开发布说明。

运行 `python3 clients/scripts/create-signing.py --directory <仓库外私密目录>` 创建签名材料；不覆盖已有材料。私密目录含PKCS12密钥与密码文件，必须另做离线加密备份，不能提交、公开上传或发到聊天。可加 `--github-repo Mike666wq/photovoltaic-air-conditioner` 用已登录gh写入四个签名Secrets，内容不输出。

Secrets为 `PVAC_ANDROID_KEYSTORE_BASE64`、`PVAC_ANDROID_STORE_PASSWORD`、`PVAC_ANDROID_KEY_PASSWORD`、`PVAC_ANDROID_KEY_ALIAS`。缺失时工作流失败，不发布debug APK或无签名包冒充正式安装包。

先手动触发 Client Packages，版本默认0.1.0-rc1、versionCode默认1。后续试装versionCode必须逐次增加且小于下一正式版编码。正式标签版本各段小于100，versionCode=`major*10000+minor*100+patch+1`，0.1.0对应101。

正式标签必须指向main已有提交；Android和Windows均构建成功、APK签名验真后才创建Release。客户端标签不会触发现有镜像Release。
