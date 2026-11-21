// 勢力ごとの占有帯とラグランジュ点領域を、軌道状態からの導出で検査する。
import { solarSystemParts } from '../physics/test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { kinematicState } from '../../src/physics/kinematic-state';
import type { KinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { addScaled, v3 } from '../../src/math/vec3';
import type { DynamicEntity } from '../../src/game/dynamic/dynamic-entity/dynamic-entity';
import {
  type Faction, factionLagrangeZones, factionOrbitZones,
} from '../../src/game/map/faction-occupancy';

const ATTRACTORS = solarSystemParts().bodies;

// 運動状態を固定した個体を返す。tag でテスト上の勢力を区別する。
function stubAt(state: KinematicState, alive = true, tag = ''): DynamicEntity {
  return { motion: { alive, stateAt: () => state }, tag } as unknown as DynamicEntity;
}

// 地球の表面から altitude [m] の円軌道(赤道面内・反時計回り)の状態。
function leoState(altitude: number, t: number): KinematicState {
  const r = R_EARTH + altitude;
  const speed = Math.sqrt(MU_EARTH / r);
  return kinematicState(t, v3(r, 0, 0), v3(0, speed, 0));
}

// 全個体を敵として数える include。
const asEnemy = (): Faction | null => 'enemy';

// 占有域の集約とラグランジュ点の所属条件を検査する。
export function register(): void {
test('faction-occupancy: 閉軌道の敵は中心天体の域へ入る', () => {
  const zones = factionOrbitZones([stubAt(leoState(420e3, 0))], ATTRACTORS, 0, asEnemy);
  assert.equal(zones.length, 1);
  assert.equal(zones[0]!.bodyId, 'earth');
  assert.equal(zones[0]!.faction, 'enemy');
  // 円軌道なので近点=遠点=動径。内側=外側になる。
  const radius = R_EARTH + 420e3;
  assert.ok(Math.abs(zones[0]!.innerRadius - radius) / radius < 1e-6);
  assert.ok(Math.abs(zones[0]!.outerRadius - radius) / radius < 1e-6);
});

test('faction-occupancy: 遷移・離脱中(閉じていない軌道)はどの域にも属さない', () => {
  const r = R_EARTH + 420e3;
  // 地球の脱出速度を超える速度 — 地球の双曲線軌道。
  const escape = Math.sqrt(2 * MU_EARTH / r) * 1.1;
  const hyperbolic = stubAt(kinematicState(0, v3(r, 0, 0), v3(0, escape, 0)));
  const zones = factionOrbitZones([hyperbolic], ATTRACTORS, 0, asEnemy);
  assert.equal(zones.length, 0);
});

test('faction-occupancy: 同じ勢力の帯は近点の最小〜遠点の最大へ畳まれる', () => {
  // 低い円軌道と高い円軌道の2機。帯は低軌道の半径〜高軌道の半径になる。
  const zones = factionOrbitZones(
    [stubAt(leoState(420e3, 0)), stubAt(leoState(800e3, 0))], ATTRACTORS, 0, asEnemy);
  assert.equal(zones.length, 1);
  const low = R_EARTH + 420e3;
  const high = R_EARTH + 800e3;
  assert.ok(Math.abs(zones[0]!.innerRadius - low) / low < 1e-6);
  assert.ok(Math.abs(zones[0]!.outerRadius - high) / high < 1e-6);
});

test('faction-occupancy: 勢力ごとに域は別立ちし、死んだ個体は数えない', () => {
  const zones = factionOrbitZones(
    [
      stubAt(leoState(420e3, 0), true, 'enemy'),
      stubAt(leoState(500e3, 0), true, 'friendly'),
      stubAt(leoState(600e3, 0), false, 'enemy'), // 死んでいるので数えない
    ],
    ATTRACTORS, 0,
    (entity) => (entity as unknown as { tag: string }).tag as Faction,
  );
  // 敵と味方で別の域になる。死体はどちらにも入らない。
  const factions = new Set(zones.map((zone) => zone.faction));
  assert.equal(zones.length, 2);
  assert.ok(factions.has('enemy'));
  assert.ok(factions.has('friendly'));
});

test('faction-occupancy: ラグランジュ点の占有は範囲内の勢力ぶんだけ立つ', () => {
  const point = { id: 'earth-l2', position: v3(1e9, 0, 0), radius: 1e6 };
  const far = addScaled(point.position, v3(1, 0, 0), 10 * point.radius);
  // 範囲内の敵だけ → 敵の域1枚。
  const enemyOnly = factionLagrangeZones(
    [{ faction: 'enemy' as const, position: point.position }], [point]);
  assert.equal(enemyOnly.length, 1);
  assert.equal(enemyOnly[0]!.faction, 'enemy');
  // 範囲外 → 域は立たない。
  const empty = factionLagrangeZones(
    [{ faction: 'enemy' as const, position: far }], [point]);
  assert.equal(empty.length, 0);
  // 両勢力が範囲内にいれば2枚。
  const both = factionLagrangeZones(
    [
      { faction: 'enemy' as const, position: point.position },
      { faction: 'friendly' as const, position: point.position },
    ],
    [point]);
  assert.equal(both.length, 2);
  assert.deepEqual(new Set(both.map((zone) => zone.faction)), new Set(['enemy', 'friendly']));
});
}
