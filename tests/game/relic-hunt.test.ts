// 遺物の反射の検出と発見: 距離の段ごとの知らせ直し、3,000〜3,600 km の保持、100 km 以内の発見、
// 直列化の往復、発見済みの遺物を判定しないこと、LAGEOS-1 の軌道の近地点・遠地点を検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { RELICS, relicById } from '../../src/game/relic-catalog';
import { RelicHunt, type RelicSignal } from '../../src/game/stages/stage-utils/relic-hunt';

const KM = 1000;
const LAGEOS = relicById('lageos-1')!;

// 単一の遺物に対して、距離の列を1つずつ観測し、出た出来事を距離の順に返す。
function observeSeries(hunt: RelicHunt, distancesKm: readonly number[]): RelicSignal[][] {
  return distancesKm.map((d) => hunt.observe([LAGEOS], () => d * KM));
}

export function register(): void {
  test('遺物: 検出距離の 3,000 km に入ると、距離を知らせ、半分になるたびに知らせ直す', () => {
    const hunt = RelicHunt.create();
    const steps = observeSeries(hunt, [3500, 2500, 2000, 1400, 1000, 700]);
    assert.deepEqual(steps.map((s) => s.map((x) => x.kind)), [[], ['reflection'], [], ['reflection'], [], ['reflection']]);
    const distances = steps.flat().map((s) => (s.kind === 'reflection' ? Math.round(s.distance / KM) : null));
    assert.deepEqual(distances, [2500, 1400, 700]);
  });

  test('遺物: 3,000〜3,600 km の帯では知らせた段を戻さず、3,600 km を超えると戻す', () => {
    const hunt = RelicHunt.create();
    observeSeries(hunt, [2500]);
    // 3,000〜3,600 km の帯の中では、段は戻らず、同じ段の再通知も起きない。
    assert.deepEqual(observeSeries(hunt, [3300, 2900])[1]!.map((s) => s.kind), []);
    // 3,600 km を超えると段が戻り、次に入ったときは最初から知らせる。
    observeSeries(hunt, [3700]);
    assert.deepEqual(observeSeries(hunt, [2900])[0]!.map((s) => s.kind), ['reflection']);
  });

  test('遺物: 100 km 以内に入ると発見になり、以後は判定しない', () => {
    const hunt = RelicHunt.create();
    const first = observeSeries(hunt, [90]);
    assert.deepEqual(first[0]!.map((s) => s.kind), ['discovered']);
    assert.deepEqual(hunt.discoveredIds, ['lageos-1']);
    assert.deepEqual(observeSeries(hunt, [50, 20])[1]!.map((s) => s.kind), []);
  });

  test('遺物: 距離が求まらなかった遺物は判定しない', () => {
    const hunt = RelicHunt.create();
    assert.deepEqual(hunt.observe([LAGEOS], () => null), []);
    assert.deepEqual(hunt.discoveredIds, []);
  });

  test('遺物: 発見済みの遺物(セーブ枠の記録)は新しいランで検出の出来事を起こさない', () => {
    const hunt = RelicHunt.create();
    hunt.markDiscovered('lageos-1');
    assert.deepEqual(observeSeries(hunt, [2000, 90])[0]!.map((s) => s.kind), []);
    assert.deepEqual(observeSeries(hunt, [90])[0]!.map((s) => s.kind), []);
  });

  test('遺物: 直列化した状態は、発見と知らせた段を保ったまま戻る', () => {
    const hunt = RelicHunt.create();
    observeSeries(hunt, [2500]);
    const restored = RelicHunt.deserialize(JSON.parse(JSON.stringify(hunt.serialize())));
    // 復元後も、段が続いているので 2,000 km では知らせず、1,400 km で知らせる。
    assert.deepEqual(observeSeries(restored, [2000])[0]!.map((s) => s.kind), []);
    assert.deepEqual(observeSeries(restored, [1400])[0]!.map((s) => s.kind), ['reflection']);
    assert.deepEqual(RelicHunt.deserialize(null).discoveredIds, []);
  });

  test('遺物: 定義は LAGEOS-1 を含み、近地点 5,860 km・遠地点 5,960 km・傾斜角 109.8° の軌道を組む', () => {
    assert.ok(RELICS.some((relic) => relic.id === 'lageos-1'));
    const earthRadius = 6378 * KM;
    const orbit = LAGEOS.orbit(earthRadius);
    assert.equal(orbit.kind, 'elements');
    if (orbit.kind !== 'elements') return;
    const perigeeAlt = orbit.a * (1 - orbit.e) - earthRadius;
    const apogeeAlt = orbit.a * (1 + orbit.e) - earthRadius;
    assert.ok(Math.abs(perigeeAlt - 5860 * KM) < 1, `近地点高度 ${perigeeAlt}`);
    assert.ok(Math.abs(apogeeAlt - 5960 * KM) < 1, `遠地点高度 ${apogeeAlt}`);
    assert.ok(Math.abs(orbit.i - (109.8 * Math.PI) / 180) < 1e-12);
  });
}
