import type { BmsDevice } from '../../services/bmsRealtimeTypes';

export function BmsConnectionGuide({ serviceRoot, device }: { serviceRoot: string; device?: BmsDevice }) {
  return <section className="bms-guide" aria-label="Windows本地接入指南">
    <h2>BMS Windows 接入向导</h2>
    <p className="bms-guide-flow">BMS 仪器 → Windows 采集程序 → HTTPS 云端 → 实时网页</p>
    <ol>
      <li><strong>注册。</strong>管理员录入 Windows 客户端的稳定 <code>deviceId</code>、实际 BMS 地址和 Pack。一个设备编号对应一台上传采集机。</li>
      <li><strong>绑定。</strong>管理员在“本地监控系统设置”选择这台 BMS 设备；没有对应采集机时可以先留空。</li>
      <li><strong>下载 Windows 手动配置说明。</strong>说明列出服务根地址、设备编号和一次性令牌。由操作人员在客户端云连接设置中手动填写；它不是可导入的客户端配置文件。先按仪器说明确认 COM 口、波特率及本地真实读数，再开启受信任 HTTPS 云连接。<dl><dt>服务根地址</dt><dd><code>{serviceRoot}</code>（不追加 /api）</dd><dt>设备编号</dt><dd>{device?.deviceId ?? '注册 Windows 客户端的 deviceId'}</dd><dt>BMS 地址</dt><dd>{device?.allowedAddresses?.join('、') ?? '按本地真实地址注册'}</dd><dt>Pack</dt><dd>{device?.allowedPacks.join('、') ?? '按本地实际 Pack 注册'}</dd></dl></li>
      <li><strong>验证心跳和实测点。</strong>网页登录 BMS 实时页，选择设备与 Pack 并开始观看。管理页中的验证结果区分客户端心跳与收到的新鲜串口实测点；只有后者到达才完成数据验证。</li>
    </ol>
    <details><summary>连接异常时检查什么？</summary><ul><li>“本地程序未在线”：检查 Windows 云连接是否开启、服务根地址、deviceId、令牌和网络。</li><li>“心跳在线，等待采样”：检查本地串口是否确实在采集，以及地址与 Pack 是否在注册范围内。</li><li>401：设备令牌不正确或已轮换；403：设备编号、地址、Pack 或模拟来源没有获准；409：观看租约失效，或同编号仍有另一活跃采集会话。</li><li>心跳不能代表采样成功。证书错误应修复信任链，不能关闭证书验证。</li></ul></details>
  </section>;
}
