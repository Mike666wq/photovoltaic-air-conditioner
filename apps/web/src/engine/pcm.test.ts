// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { derivePcmVisual } from './pcm';

const probe = (pcm_temp: number) =>
  derivePcmVisual({ pump_on: true, pump_flow: 3, pcm_temp });

describe('PCM 视觉派生 · 温度读数真实性', () => {
  it('tempText 恒等于实测温度，不做钳位也不伪造平台期常数', () => {
    for (const t of [0, 1, 2, 8.6, 10, 12.4, 22, 24.9, 25, 28.2, 30, 45, 48.9, 49, 50]) {
      expect(probe(t).tempText).toBe(`${t.toFixed(1)}℃`);
    }
  });

  it('不同实测温度不再塌缩成同一个显示值（回归：曾恒为 25.0℃）', () => {
    const samples = [2, 8.6, 10, 12.4, 22, 30, 45, 48.9].map((t) => probe(t).tempText);
    expect(new Set(samples).size).toBe(samples.length);
    expect(samples).not.toContain('25.0℃');
  });

  it('状态文字只描述相态，不含任何温度数字', () => {
    for (const t of [2, 10, 22, 30, 45, 48.9]) {
      expect(probe(t).statusText).not.toMatch(/\d/);
    }
    expect(probe(2).statusText).toBe('释热·相变区');
    expect(probe(30).statusText).toBe('蓄热·相变区');
    expect(probe(0).statusText).toBe('固态');
    expect(probe(50).statusText).toBe('液态');
  });

  it('相态判定与融化比例不受温度读数修复影响', () => {
    expect(probe(0).phase).toBe('solid');
    expect(probe(50).phase).toBe('liquid');
    expect(probe(10).phase).toBe('freezing');
    expect(probe(30).phase).toBe('melting');
    expect(probe(0).meltText).toBe('0%');
    expect(probe(50).meltText).toBe('100%');
  });

  it('过渡时长仍按泵状态收敛', () => {
    // 泵开但流量为 0 视为未换热，走泵停分支（30s 视觉冻结）
    expect(derivePcmVisual({ pump_on: true, pump_flow: 0, pcm_temp: 30 }).transitionSec).toBe(30);
    expect(derivePcmVisual({ pump_on: true, pump_flow: 2, pcm_temp: 30 }).transitionSec).toBe(4);
    expect(derivePcmVisual({ pump_on: true, pump_flow: 100, pcm_temp: 30 }).transitionSec).toBe(1.5);
    expect(derivePcmVisual({ pump_on: false, pump_flow: 0, pcm_temp: 30 }).transitionSec).toBe(30);
  });
});
