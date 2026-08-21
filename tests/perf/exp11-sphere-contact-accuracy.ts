// 実験11: 掃引接触判定の解法別精度。
// 「接触したか否か」が覆る半径和 R* を二分探索で求め、真の最接近距離との差 [m] で誤差を測る。
// 負なら偽陽性側(近似が天体に近づきすぎ)、正なら偽陰性側(すり抜け)。
// R* − 真値 は2つの要因の和なので、それぞれを分けて出す:
//   近似の誤差 = 近似曲線の最接近距離 − 真の最接近距離
//   実装の許容 = R*(判定器) − 近似曲線の最接近距離   ← 細分の打ち切りで拾えなかった分
import { Ephemeris } from '../../src/physics/ephemeris';
import { Vec3, add, cross, norm, scale, v3 } from '../../src/physics/vec3';
import * as C from '../../src/game/const';
import { SHIP_BCINV, buildEphemeris } from './common';
import { KinematicState } from '../../src/physics/kinematic-state';
import {
  Advance, EARTH, EARTH_AIR, MOON, SMALL, SOLVERS, Sweep, againstBody, beforePerigee, circular,
  circularPeriod, companion, freeFall, sweepOf, withDrag, withThrust,
} from './sphere-contact-sweeps';
import { flipRadius, minDistanceOf } from './sphere-contact-reference';
// 分岐基準そのもの。判定器が公開している式を、実誤差との対応を測るのに使う。
import { sweptSagitta } from '../../src/physics/sphere-contact';

// 船の全開加速度 [m/s^2](BASE_THRUST のコメントが基準にしている値)。
const SHIP_ACCEL = 400;

function fmt(m: number): string {
  const a = Math.abs(m);
  if (a >= 1e3) return `${(m / 1e3).toFixed(1)} km`;
  if (a >= 1) return `${m.toFixed(1)} m`;
  if (a >= 1e-3) return `${(m * 1e3).toFixed(1)} mm`;
  return `${(m * 1e6).toFixed(1)} µm`;
}

function report(list: readonly Sweep[]): void {
  console.log('配置 | 近似 | 近似の誤差 | 実装の許容 | 合計(R* − 真値)');
  console.log('--- | --- | --- | --- | ---');
  for (const s of list) {
    for (const solver of SOLVERS) {
      const approx = minDistanceOf(s, solver);
      const flip = flipRadius(s, solver);
      const cells = flip === null
        ? `${fmt(approx - s.trueMin)} | 測定不能 | 測定不能`
        : `${fmt(approx - s.trueMin)} | ${fmt(flip - approx)} | ${fmt(flip - s.trueMin)}`;
      console.log(`${s.label} | ${solver} | ${cells}`);
    }
  }
}

// 高度 413 km の LEO 円軌道を、1周あたり steps 歩の刻みで渡る区間。
function leoAt(steps: number, air: boolean): Sweep {
  const central = air ? EARTH_AIR : EARTH;
  const alt = air ? 250e3 : 413e3;
  const s0 = circular(central, alt);
  const dt = circularPeriod(central, central.radius + alt) / steps;
  const advance = air ? withDrag(central, SHIP_BCINV) : freeFall(central);
  return againstBody(`LEO ${steps} 歩/周回${air ? '(空気抵抗つき)' : ''}`, central, s0, dt, advance);
}

// 近点を区間の割合 frac に置いた楕円の1歩。
function perigeeAt(e: number, frac: number, steps: number): Sweep {
  const rp = EARTH.radius + 120e3;
  const dt = circularPeriod(EARTH, rp) / steps;
  const s0 = beforePerigee(EARTH, rp, e, dt, frac);
  return againstBody(`近点跨ぎ e=${e} frac=${frac} ${steps} 歩/周回`, EARTH, s0, dt, freeFall(EARTH));
}

// 相対速度 relV ですれ違う相手。区間の中ほどで最接近 miss になるよう、相対変位の半分だけ
// 手前へ置き、relV と動径の両方に直交する向きへ miss だけずらす。
function passingBy(
  label: string, base: KinematicState, dt: number, relV: Vec3, miss: number,
  advanceA: Advance, advanceB: Advance,
): Sweep {
  const side = scale(norm(cross(relV, base.r)), miss);
  const b0 = companion(base, add(scale(relV, -dt / 2), side), relV);
  return sweepOf(label, base, b0, dt, advanceA, advanceB, miss / 2);
}

// 戦闘は低時間加速で起きる設計なので、刻みは ×1 の1フレームから ×4 のサブステップ上限まで振る。
// 面外へ抜ける相対速度に対して、ずれの向き(side)は −y になる。推力はその向きを打ち消す +y に
// 取って、最接近距離そのものを推力で動かす配置にする。
function entityPairs(): readonly Sweep[] {
  const leo = circular(EARTH, 413e3);
  const fall = freeFall(EARTH);
  const thrust = withThrust(EARTH, v3(0, SHIP_ACCEL, 0));
  const low = circular(EARTH_AIR, 200e3);
  const outward = v3(0, 0, -40);
  const list: Sweep[] = [];
  for (const dt of [1 / 60, 1, 20]) {
    const h = dt < 1 ? '1/60 s' : `${dt} s`;
    list.push(passingBy(`低速すれ違い h=${h}`, leo, dt, outward, 500, fall, fall));
    list.push(passingBy(`片側に全開推力 h=${h}`, leo, dt, outward, 500, fall, thrust));
    list.push(passingBy(`逆行すれ違い h=${h}`, leo, dt, scale(leo.v, -2), 500, fall, fall));
  }
  list.push(passingBy('抵抗差(高度 200 km)h=20 s', low, 20, outward, 500,
    withDrag(EARTH_AIR, SHIP_BCINV), freeFall(EARTH_AIR)));
  return list;
}

// s が弦の誤差をどれだけ言い当てるか。1 を下回ると過小評価で、閾値としては危険側になる。
function reportCriterion(list: readonly Sweep[]): void {
  console.log('配置 | s = |Δv|h/8 | 弦の実誤差 | s / |弦の実誤差|');
  console.log('--- | --- | --- | ---');
  for (const sw of list) {
    const s = sweptSagitta(sw.aStart, sw.aEnd, sw.bStart, sw.bEnd);
    const err = minDistanceOf(sw, '弦') - sw.trueMin;
    const ratio = Math.abs(err) > 1e-9 ? (s / Math.abs(err)).toFixed(3) : '—';
    console.log(`${sw.label} | ${fmt(s)} | ${fmt(err)} | ${ratio}`);
  }
}

// 半径和で相手の素性を見分けられるかを、両方の母集団の実際の範囲で確かめる。
function radiusSumRange(ephemeris: Ephemeris): void {
  const entities: readonly (readonly [string, number])[] = [
    ['弾', C.BULLET_RADIUS], ['補給', C.AMMO_PHYS_RADIUS], ['空マガジン', C.EJECTED_MAG_PHYS_RADIUS],
    ['自機', C.PLAYER_HULL_RADIUS], ['敵', C.ENEMY_RADIUS],
  ];
  const maxSum = Math.max(...entities.map(([, r]) => r)) * 2;
  const bodies = [...ephemeris.attractorsAt(0)].sort((a, b) => a.radius - b.radius);
  console.log(`個体の半径: ${entities.map(([n, r]) => `${n} ${r} m`).join('、')}`);
  console.log(`→ 個体どうしの半径和は最大 ${maxSum.toFixed(0)} m\n`);
  const overlap = bodies.filter((b) => b.radius < maxSum);
  console.log(`天体の半径: 最小 ${bodies[0]!.radius} m(${bodies[0]!.id})`
    + ` / 最大 ${bodies[bodies.length - 1]!.radius.toExponential(2)} m`);
  console.log(`→ 半径が ${maxSum} m を下回る天体が ${overlap.length} 体ある: `
    + `${overlap.map((b) => `${b.id} ${b.radius} m`).join('、')}`);
}

// 現状の刻み規則で、表面すれすれの円軌道が1周あたり何歩になるか。
function stepsPerRevolution(ephemeris: Ephemeris): void {
  const steps: readonly (readonly [string, number])[] = [
    ['実シミュレーション 通常', 20], ['実シミュレーション 最高ワープ', 34.1],
    ['弧 最小刻み', 40], ['弧 28日表示の粗化刻み', 121],
  ];
  let worst = Infinity;
  let worstId = '';
  for (const b of ephemeris.attractorsAt(0)) {
    if (!(b.mu > 0) || !(b.radius > 0)) continue;
    const period = 2 * Math.PI * Math.sqrt(b.radius ** 3 / b.mu);
    if (period < worst) { worst = period; worstId = b.id; }
  }
  console.log(`表面すれすれの周期が最も短い天体: ${worstId} (${worst.toFixed(0)} s)\n`);
  console.log('刻み | h | その天体での歩/周回');
  console.log('--- | --- | ---');
  for (const [label, h] of steps) console.log(`${label} | ${h} s | ${(worst / h).toFixed(0)}`);
}

export function run(): void {
  console.log('# 実験11: 掃引接触判定の解法別精度\n');
  console.log('## 天体まわりの周回(刻みを振る)\n');
  report([3, 4, 6, 10, 20, 50, 140].map((n) => leoAt(n, false)).reverse());

  console.log('\n## 空気抵抗つきの LEO(高度 250 km)\n');
  report([140, 20, 6].map((n) => leoAt(n, true)));

  console.log('\n## 近点跨ぎ\n');
  report([
    perigeeAt(0.1, 0.5, 140), perigeeAt(0.9, 0.5, 140), perigeeAt(0.9, 0.1, 140),
    perigeeAt(0.1, 0.5, 20), perigeeAt(0.9, 0.5, 20), perigeeAt(0.9, 0.1, 20),
    perigeeAt(0.9, 0.5, 6),
  ]);

  console.log('\n## 周回の中心が地球でない配置\n');
  report([
    againstBody('月 140 歩/周回', MOON, circular(MOON, 100e3),
      circularPeriod(MOON, MOON.radius + 100e3) / 140, freeFall(MOON)),
    againstBody('月 6 歩/周回', MOON, circular(MOON, 100e3),
      circularPeriod(MOON, MOON.radius + 100e3) / 6, freeFall(MOON)),
    againstBody('小天体(半径 50 km)140 歩/周回', SMALL, circular(SMALL, 10e3),
      circularPeriod(SMALL, SMALL.radius + 10e3) / 140, freeFall(SMALL)),
    againstBody('小天体(半径 50 km)6 歩/周回', SMALL, circular(SMALL, 10e3),
      circularPeriod(SMALL, SMALL.radius + 10e3) / 6, freeFall(SMALL)),
  ]);

  console.log('\n## 個体どうし(刻み 20 s、半径和 20 m)\n');
  report(entityPairs());

  console.log('\n## 分岐基準 s = |Δv|·h/8 の妥当性\n');
  reportCriterion([
    ...[140, 20, 6, 3].map((n) => leoAt(n, false)),
    perigeeAt(0.9, 0.5, 140), perigeeAt(0.9, 0.1, 20),
    againstBody('月 140 歩/周回', MOON, circular(MOON, 100e3),
      circularPeriod(MOON, MOON.radius + 100e3) / 140, freeFall(MOON)),
    againstBody('小天体(半径 50 km)140 歩/周回', SMALL, circular(SMALL, 10e3),
      circularPeriod(SMALL, SMALL.radius + 10e3) / 140, freeFall(SMALL)),
    ...entityPairs(),
  ]);

  console.log('\n## 半径和で相手の素性を見分けられるか\n');
  radiusSumRange(buildEphemeris());

  console.log('\n## 現状の刻みで出得る 歩/周回\n');
  stepsPerRevolution(buildEphemeris());
  console.log('\n(最接近距離の参照は sphere-contact-reference.ts。'
    + ' 真値は同じ運動を 4000 分割で積んだ経路の最小距離。)');
}

if (require.main === module) run();
