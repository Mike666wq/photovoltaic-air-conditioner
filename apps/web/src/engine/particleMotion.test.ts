import { describe, expect, it } from 'vitest';
import { advanceParticleDistance, polylineLength } from './particleMotion';

describe('particle motion', () => {
  it('按折线真实长度计算', () => {
    expect(polylineLength([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }])).toBe(70);
  });

  it('30/60/120Hz 运行一秒得到相同距离', () => {
    const simulate = (hz: number) => {
      let distance = 0;
      for (let frame = 0; frame < hz; frame++) {
        distance = advanceParticleDistance(distance, 90, 1000 / hz, 1, 1000);
      }
      return distance;
    };
    expect(simulate(30)).toBeCloseTo(90, 8);
    expect(simulate(60)).toBeCloseTo(simulate(30), 8);
    expect(simulate(120)).toBeCloseTo(simulate(30), 8);
  });

  it('缩放时保持屏幕速度一致', () => {
    const worldAtHalfZoom = advanceParticleDistance(0, 100, 1000, 0.5, 1000);
    expect(worldAtHalfZoom * 0.5).toBe(100);
  });
});
