import type { BmsDevice } from '../../services/bmsRealtimeTypes';

export function BmsConnectionGuide({ serviceRoot, device }: { serviceRoot: string; device?: BmsDevice }) {
  return <section className="bms-guide" aria-label="Windows本地接入指南">
    <h2>Windows 本地配置与联通步骤</h2>
    <p className="bms-guide-flow">BMS 仪器 → Windows 采集程序 → HTTPS 云端 → 实时网页</p>
    <ol>
      <li><strong>先确认本地采集正常。</strong>打开 Windows BMS 客户端，按仪器说明选择 COM 口、波特率、校验等参数。确认本地已经显示真实读数，再配置云连接。</li>
      <li><strong>注册这台采集设备。</strong>把客户端保存的 <code>deviceId</code>、实际 BMS 地址和 Pack 填入云端设备注册表。一个设备编号对应一台正在上传的采集机。</li>
      <li><strong>填写本地云连接配置。</strong><dl><dt>服务根地址</dt><dd><code>{serviceRoot}</code>（只填域名根，不追加 /api）</dd><dt>设备编号 deviceId</dt><dd>{device?.deviceId ?? '填写注册时与本地客户端一致的设备编号'}</dd><dt>设备上传令牌</dt><dd>填入注册或轮换时生成的令牌；它用于本地程序上传，网页登录使用观看账户密码。</dd><dt>BMS 地址 address</dt><dd>{device?.allowedAddresses?.join('、') ?? '按本地采集的真实地址注册，不能照抄示例'}</dd><dt>Pack</dt><dd>{device?.allowedPacks.join('、') ?? '按本地正在采集的电池包编号注册'}</dd></dl></li>
      <li><strong>开启本地云连接，保持程序运行。</strong>使用受信任证书的 HTTPS，保持本地采集。网页观看按钮不会远程启动 EXE 或打开串口。</li>
      <li><strong>网页登录并开始观看。</strong>在 BMS 实时页选择设备和 Pack，点击“连接本地数据源”。通常等待下一次心跳，约15秒加网络耗时。</li>
      <li><strong>核对读数并验证停止。</strong>对照同一时间的总压、电流与 SOC。网页断开观看后上传暂停，本地采集与完整记录继续。</li>
    </ol>
    <details><summary>连接异常时检查什么？</summary><ul><li>“本地程序未在线”：检查 Windows 云连接是否开启、服务根地址、deviceId、令牌和网络。</li><li>“心跳在线，等待采样”：检查本地串口是否确实在采集，以及地址与 Pack 是否在注册范围内。</li><li>401：设备令牌不正确或已轮换；403：设备编号、地址、Pack 或模拟来源没有获准；409：观看租约失效，或同编号仍有另一活跃采集会话。</li><li>若只有首次样本，随后断开：请管理员检查反向代理的 SSE 缓冲和超时。证书错误应修复信任链，不能关闭证书验证。</li></ul></details>
  </section>;
}
