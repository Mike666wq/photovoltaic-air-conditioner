import type { BmsDevice } from '../../services/bmsRealtimeTypes';

export function ExperimentConnectionGuide({ serviceRoot, device }: { serviceRoot: string; device?: BmsDevice }) {
  return <section className="bms-admin-card bms-connection-guide" aria-label="实验客户端接入向导">
    <h2>实验监控 Windows 接入向导</h2>
    <p>DS666 / PLC / DDSU666 / DJSF6682 → Windows 实验采集客户端 → HTTPS 云端 → 实验监控网页</p>
    <ol>
      <li><strong>注册。</strong>录入实验客户端在 <code>settings/cloud.txt</code> 使用的稳定 deviceId，并勾选实际授权仪器。BMS 和实验源分别注册。</li>
      <li><strong>配置客户端。</strong>管理页提供服务根地址、deviceId 与一次性令牌的 Windows 手动配置说明，由操作人员填入客户端云连接设置。说明不是可导入的客户端配置文件。客户端使用受信任 HTTPS；令牌由当前 Windows 用户 DPAPI 保护，不要手工写入明文。<dl><dt>服务根地址</dt><dd><code>{serviceRoot}</code>（不追加 /api）</dd><dt>deviceId</dt><dd>{device?.deviceId ?? '从 Windows 客户端复制稳定编号'}</dd><dt>允许仪器</dt><dd>{device?.allowedEquipment?.join('、') ?? '按实际授权勾选'}</dd></dl></li>
      <li><strong>从设备列表开始观测并验证。</strong>打开实时观测设备列表，选择这台设备后开始观看。本地先确认串口采集及 SQLite 记录正常；心跳在线只证明客户端连通，须收到新鲜的真实测点才算数据验证完成。四台仪器依次观测，时间并不同步；网页停止观看后上传暂停，本地记录继续。</li>
    </ol>
    <details><summary>连接异常时检查什么？</summary><p>401：令牌失效或未配置；403：令牌模块、仪器权限不匹配；409：租约失效，本地应重新心跳。心跳在线只表明客户端连通，不代表仪器采到了真实数据。检查客户端采集状态和逐点时间；检查 /api/experiment/heartbeat 与 /api/experiment/snapshots 直接返回 JSON，不能重定向到登录页。网页不能控制 PLC 或串口。</p></details>
    {device && <small>当前设备：{device.alias} · {device.deviceId} · 仪器：{device.allowedEquipment?.join('、') || '未配置'}</small>}
  </section>;
}
