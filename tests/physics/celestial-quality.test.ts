import * as assert from 'node:assert/strict';
import { CELESTIAL_QUALITY, celestialQualityFor } from '../../src/physics/celestial-quality';
import { test } from './harness';

export function register(): void {
  test('天体品質LODは投影半径に対して単調で、主要オーロラを常に残す', () => {
    assert.equal(celestialQualityFor(20), 'low');
    assert.equal(celestialQualityFor(200), 'medium');
    assert.equal(celestialQualityFor(600), 'high');
    assert.ok(CELESTIAL_QUALITY.low.auroraCurtains >= 2);
    assert.ok(CELESTIAL_QUALITY.high.auroraCurtains > CELESTIAL_QUALITY.medium.auroraCurtains);
  });

  test('高DPIでは同じCSS投影半径を高い品質へ割り当てる', () => {
    assert.equal(celestialQualityFor(100, 1), 'low');
    assert.equal(celestialQualityFor(100, 2), 'medium');
    assert.equal(celestialQualityFor(Number.NaN, Number.NaN), 'low');
  });
}
