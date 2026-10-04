import type { BmsDevice } from '../../services/bmsRealtimeTypes';

export function ExperimentConnectionGuide({ serviceRoot, device }: { serviceRoot: string; device?: BmsDevice }) {
  return <section className="bms-admin-card bms-connection-guide" aria-label="实验客户端接入向导">
    <h2>实验监控 Windows 接入向导</h2>
    <p>DS666 / PLC / DDSU666 / DJSF6682 → Windows 实验采集客户端 → HTTPS 云端 → 实验监控网页</p>
    <ol>
      <li><strong>注册。</strong>录入实验客户端在 <code>settings/cloud.txt</code> 使用的稳定 deviceId，并勾选实际授权仪器。BMS 和实验源分别注册。</li>
      <li><strong>绑定。</strong>管理员在“本地监控系统设置”选择这台实验采集机；当前没有可用采集机时可留空。</li>
      <li><strong>下载 Windows 手动配置说明。</strong>说明提供服务根地址、deviceId 与一次性令牌，由操作人员在客户端云连接设置中手动填写。它不是可导入的客户端配置文件。客户端使用受信任 HTTPS；令牌由当前 Windows 用户 DPAPI 保护，不要手工写入明文。<dl><dt>服务根地址</dt><dd><code>{serviceRoot}</code>（不追加 /api）</dd><dt>deviceId</dt><dd>{device?.deviceId ?? '从 Windows 客户端复制稳定编号'}</dd><dt>允许仪器</dt><dd>{device?.allowedEquipment?.join('、') ?? '按实际授权勾选'}</dd></dl></li>
      <li><strong>验证心跳和真实测点。</strong>本地先确认串口采集及 SQLite 记录正常，再登录实验监控开始观看。管理页验证会分别显示客户端心跳与新鲜串口实测点；只有实测点到达才完成数据验证。四台仪器依次观测，时间并不同步；网页停止观看后上传暂停，本地记录继续。</li>
    </ol>
    <details><summary>连接异常时检查什么？</summary><p>401：令牌失效或未配置；403：令牌模块、仪器权限或模拟来源不匹配；409：租约失效，本地应重新心跳。心跳在线只表明客户端连通，不代表仪器采到了真实数据。检查客户端采集状态和逐点时间；检查 /api/experiment/heartbeat 与 /api/experiment/snapshots 直接返回 JSON，不能重定向到登录页。网页不能控制 PLC 或串口。</p></details>
    {device && <small>当前设备：{device.alias} · {device.deviceId} · 仪器：{device.allowedEquipment?.join('、') || '未配置'}</small>}
  </section>;
}
