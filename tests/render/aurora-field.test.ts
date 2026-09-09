import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { AuroraField } from '../../src/render/aurora-field';

export function register(): void {
  test('aurora field: same display time is deterministic and bounded', () => {
    const field = new AuroraField({ ovalLatitudeDeg: 66, geomSeed: 1.3, colorSeed: 2.7, phaseOffset: 1, sign: 1 });
    const a = field.frameAt(1.2, 42);
    const b = field.frameAt(1.2, 42);
    assert.deepEqual(a, b);
    assert.ok(a.intensity >= 0 && a.intensity <= 1);
    assert.ok(a.greenEmission >= 0 && a.greenEmission <= 1);
    assert.ok(a.redEmission >= 0 && a.redEmission <= 1);
  });

  test('aurora field: day side is continuously brighter than night side', () => {
    const field = new AuroraField({ ovalLatitudeDeg: 66, geomSeed: 0, colorSeed: 0, phaseOffset: 0, sign: 1 });
    assert.ok(field.frameAt(0, 3).intensity > field.frameAt(Math.PI, 3).intensity);
  });
}
