import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { AtmosphericWindField, CloudPatternTransport } from '../../src/render/cloud/atmospheric-wind';

// 模様を載せる天体の半径 [m]。角位相は半径で割って出るので、値そのものは判定に効かない。
const SURFACE_RADIUS = 6.371e6;

export function register(): void {
  test('atmospheric wind: vertical shear is continuous and altitude dependent', () => {
    const field = new AtmosphericWindField();
    const surface = field.sample(45 * Math.PI / 180, 1_000);
    const upper = field.sample(45 * Math.PI / 180, 10_000);
    assert.ok(upper.east > surface.east);
    const near = field.sample(45 * Math.PI / 180, 9_999);
    assert.ok(Math.abs(upper.east - near.east) < 0.01);
  });

  test('atmospheric wind: latitude bands blow the right way at the surface', () => {
    const field = new AtmosphericWindField();
    // 貿易風は東向き成分が負、偏西風は正、極偏東風は負。
    assert.ok(field.sample(15 * Math.PI / 180, 1_000).east < 0);
    assert.ok(field.sample(45 * Math.PI / 180, 1_000).east > 0);
    assert.ok(field.sample(75 * Math.PI / 180, 1_000).east < 0);
    // 南北半球で鏡像: 東西成分は等しく、南北成分は符号が反転する。
    const north = field.sample(45 * Math.PI / 180, 1_000);
    const south = field.sample(-45 * Math.PI / 180, 1_000);
    assert.equal(south.east, north.east);
    assert.equal(south.north, -north.north);
  });

  test('atmospheric wind: mid-latitude westerlies strengthen with height', () => {
    const field = new AtmosphericWindField();
    const surface = field.sample(45 * Math.PI / 180, 1_000);
    const upper = field.sample(45 * Math.PI / 180, 10_000);
    assert.ok(upper.east > surface.east);
    assert.ok(surface.east > 0);
  });

  test('atmospheric wind: eastward component has no seam along latitude', () => {
    const field = new AtmosphericWindField();
    let previous = field.sample(0, 1_000).east;
    for (let degrees = 0.5; degrees <= 90; degrees += 0.5) {
      const east = field.sample(degrees * Math.PI / 180, 1_000).east;
      assert.ok(Math.abs(east - previous) < 1.5);
      previous = east;
    }
  });

  test('cloud pattern transport: phase is deterministic and does not alter physical wind', () => {
    const field = new AtmosphericWindField();
    const transport = new CloudPatternTransport(SURFACE_RADIUS, field);
    assert.equal(transport.phaseAt(0.4, 1_000, 3600), transport.phaseAt(0.4, 1_000, 3600));
    assert.deepEqual(field.sample(0.4, 1_000), field.sample(0.4, 1_000));
  });

  test('cloud pattern transport: m/s phase conversion scales with elapsed time', () => {
    const transport = new CloudPatternTransport(SURFACE_RADIUS);
    const oneDay = transport.angularPhase(10, 0, 0, 86400).east;
    const twoDays = transport.angularPhase(10, 0, 0, 2 * 86400).east;
    assert.ok(oneDay > 0);
    assert.ok(Math.abs(twoDays - 2 * oneDay) < 1e-12);
  });
}
