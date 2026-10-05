# Android 监控客户端

Kotlin 原生 WebView；Android 10（API 29）以上，包名 `xyz.bbben.pvac.monitor`，固定入口 `https://pv-ac.bbben.xyz/`。

## 构建

使用已有 Android Studio 导入本目录，要求 JDK 17、Android SDK 35、Gradle 8.11.1。若已有对应 Gradle，可执行 `gradle :app:assembleDebug`。仓库不包含伪造的 wrapper JAR，也不自动安装系统构建工具。首轮实现环境无 Gradle 与 Android SDK，尚未执行 Kotlin 编译或真机验证。

发布执行 `gradle :app:assembleRelease`，必须提供以下环境变量；缺失任何一个时 Release 任务拒绝运行：

- `PVAC_ANDROID_KEYSTORE`：签名密钥库路径（绝对路径推荐）。
- `PVAC_ANDROID_STORE_PASSWORD`：密钥库密码。
- `PVAC_ANDROID_KEY_ALIAS`：密钥别名。
- `PVAC_ANDROID_KEY_PASSWORD`：密钥密码。
- `PVAC_VERSION`：客户端版本名，默认 `0.1.0-dev`。
- `PVAC_VERSION_CODE`：递增整数版本号，默认 `1`。
- `PVAC_BUILD_SHA`：7～40 位十六进制 Git SHA，默认 `unknown`；关于页显示此值。

私钥及密码不写入仓库。图标 `app/src/main/res/drawable/ic_launcher.xml` 与 `clients/shared/icon.svg` 使用同一图案、几何与配色。关于页提供 GitHub Release 下载按钮。

## 网页桥

原生只调用固定 `window.PvAcClient.back()`、`canDiscard()`、`setForeground(boolean)` 和 `onSaveResult(id,status)`。两个返回函数同步返回布尔值。返回先让网页处理，然后检查历史，最后确认退出。刷新／监控主页／原生历史返回在 `canDiscard()` 返回 false 时确认。后台与恢复仅通知前后台，不重新加载。后台不调用 `onPause` 或 `pauseTimers`，让释放租约请求 best effort 执行；进程挂起或网络中断时仍依服务端 45 秒 TTL 回收。旋转由同一 Activity 处理，不重建 WebView；CookieManager 持久保存第一方 cookie。

网页调用 `window.pvAcNative.postMessage(JSON.stringify({type:'saveText',id,fileName,text}))`。只有固定 HTTPS origin 的主框架可调用；不提供任意脚本、路径或导航接口。文件名拒绝路径分隔符、控制字符及不合法名称，正文最大为 UTF-8 1 MiB。通过系统 SAF 保存；回传状态为 `saved`、`cancelled`、`failed`。系统 WebView 不支持 WebMessageListener 时禁用保存桥并提示更新，不退回不安全的 JavaScriptInterface。

导入通过系统文档选择器支持多选 CSV、XLS、XLSX、PDF；不申请全盘存储权限。允许 `content://` 读取以支持 SAF 返回的 URI，权限由系统文档选择授权限定；禁止 `file://`。网页用户主动点击复制时可调用 `window.pvAcNative.postMessage(JSON.stringify({type:"copyText",id,text}))`，使用系统 `ClipboardManager.setPrimaryClip` 写入；同样限制固定 HTTPS origin 主框架与 UTF-8 1 MiB，复用 `onSaveResult(id,"saved"|"failed")` 回执。不读取剪贴板、不缓存或记录正文，不由原生持久保存密码。其他 HTTP/S 站点交由外部浏览器，其余协议阻止。SSL 错误取消。主框架网络／HTTP 错误显示重试。正文和令牌不写日志；WebView 调试仅 Debug 构建开启。

## 待验收

在具备 SDK 的环境运行 Debug／签名 Release 构建；Android 10 与较新 Android 真机验证旋转、登录持久化、后台租约恢复、系统返回与工具按钮、SAF 多选／取消／写入失败、站点外跳、证书失败、弱网重试，以及外站／子框架无法调用保存桥。客户端版本与网页部署版本分别展示，网页版本以页面页眉为准。

完整功能demo默认原理图，第二行常驻原理图、数据分析、实时监控；模块使用SPA切换保留导入数据。
