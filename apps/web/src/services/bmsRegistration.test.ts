import { describe, expect, it } from 'vitest';
import { connectionInstructions, registrationNumbers } from './bmsRegistration';
describe('设备注册及本地配置口径', () => {
  it('地址与Pack支持中文逗号、去重和排序，拒绝空值、范围外及非整数', () => {
    expect(registrationNumbers('2，1,2',16)).toEqual([1,2]);
    for (const text of ['', '1,', '0', '17', '1.5', 'abc']) expect(()=>registrationNumbers(text,16)).toThrow();
    expect(registrationNumbers('255',255)).toEqual([255]);
  });
  it('导出包含真实注册字段与独立令牌，明确域名根、采集先运行和停止观看语义', () => {
    const text=connectionInstructions({device:{deviceId:'fixture-device',alias:'测试',allowedAddresses:[2],allowedPacks:[1,3],online:false,lastHeartbeatAt:null},deviceToken:'disposable-fixture-token'},'https://example.test');
    expect(text).toContain('https://example.test'); expect(text).toContain('fixture-device'); expect(text).toContain('address：2'); expect(text).toContain('Pack：1, 3'); expect(text).toContain('disposable-fixture-token'); expect(text).toContain('不追加/api'); expect(text).toContain('本地记录仍继续');
  });
});
