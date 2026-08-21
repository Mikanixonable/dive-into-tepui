// 実験11: 掃引接触判定の解法別精度。
// 「接触したか否か」が覆る半径和 R* を二分探索で求め、真の最接近距離との差 [m] で誤差を測る。
// 負なら偽陽性側(近似が天体に近づきすぎ)、正なら偽陰性側(すり抜け)。
// R* − 真値 は2つの要因の和なので、それぞれを分けて出す:
//   近似の誤差 = 近似曲線の最接近距離 − 真の最接近距離
//   実装の許容 = R*(判定器) − 近似曲線の最接近距離   ← 細分の打ち切りで拾えなかった分
import { Ephemeris } from '../../src/physics/ephemeris';
import { SweptMode, sweptSphereContact } from '../../src/physics/sphere-contact';
import { Vec3, add, cross, len, norm, scale, sub, v3 } from '../../src/physics/vec3';
import { SHIP_BCINV, buildEphemeris } from './common';
import { KinematicState } from '../../src/physics/kinematic-state';
import {
  Advance, EARTH, EARTH_AIR, MOON, SMALL, Sweep, againstBody, beforePerigee, circular, circularPeriod,
  companion, freeFall, sweepOf, withDrag, withThrust,
} from './sphere-contact-sweeps';

const MODES: readonly SweptMode[] = ['linear', 'quadratic', 'cubic'];
const SAMPLES = 200001;
// 船の全開加速度 [m/s^2](BASE_THRUST のコメントが基準にしている値)。
const SHIP_ACCEL = 400;

// 判定器と同じ制御点で曲線を張り、原点との最接近距離を密なサンプリングで出す。
// 判定器の実装とは独立に持つ — 判定器がその最接近距離をどこで拾うかを測っているため。
function controlPoints(s: Sweep, mode: SweptMode): readonly Vec3[] {
  const dt = s.aEnd.t - s.aStart.t;
  const p0 = sub(s.bStart.r, s.aStart.r);
  const p1 = sub(s.bEnd.r, s.aEnd.r);
  const t0 = scale(sub(s.bStart.v, s.aStart.v), dt);
  const t1 = scale(sub(s.bEnd.v, s.aEnd.v), dt);
  if (mode === 'linear') return [p0, p1];
  if (mode === 'quadratic') {
    return [p0, v3(
      (p0.x + p1.x) / 2 + (t0.x - t1.x) / 4,
      (p0.y + p1.y) / 2 + (t0.y - t1.y) / 4,
      (p0.z + p1.z) / 2 + (t0.z - t1.z) / 4), p1];
  }
  return [p0,
    v3(p0.x + t0.x / 3, p0.y + t0.y / 3, p0.z + t0.z / 3),
    v3(p1.x - t1.x / 3, p1.y - t1.y / 3, p1.z - t1.z / 3), p1];
}

function bezierAt(control: readonly Vec3[], u: number): Vec3 {
  let level = control;
  while (level.length > 1) {
    const next: Vec3[] = [];
    for (let i = 0; i + 1 < level.length; i++) {
      const a = level[i]!, b = level[i + 1]!;
      next.push(v3(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u));
    }
    level = next;
  }
  return level[0]!;
}

function minDistanceOf(s: Sweep, mode: SweptMode): number {
  const control = controlPoints(s, mode);
  let best = Infinity;
  let bu = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const u = i / (SAMPLES - 1);
    const d = len(bezierAt(control, u));
    if (d < best) { best = d; bu = u; }
  }
  let lo = Math.max(0, bu - 1 / (SAMPLES - 1));
  let hi = Math.min(1, bu + 1 / (SAMPLES - 1));
  for (let k = 0; k < 120; k++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (len(bezierAt(control, m1)) < len(bezierAt(control, m2))) hi = m2; else lo = m1;
  }
  return Math.min(best, len(bezierAt(control, (lo + hi) / 2)));
}

function crosses(s: Sweep, mode: SweptMode, radiusSum: number): boolean {
  const c = sweptSphereContact(s.aStart, s.aEnd, s.bStart, s.bEnd, radiusSum, mode);
  return c !== null && !c.startsInside && c.crossing !== null;
}

// 判定が「跨ぎなし」から「跨ぐ」へ反転する半径和。始点で重なる手前までを上限に取る。
function flipRadius(s: Sweep, mode: SweptMode): number | null {
  let hi = Math.min(len(sub(s.bStart.r, s.aStart.r)), len(sub(s.bEnd.r, s.aEnd.r))) * (1 - 1e-13);
  if (!crosses(s, mode, hi)) return null;
  let lo = 0;
  for (let k = 0; k < 100; k++) {
    const mid = (lo + hi) / 2;
    if (crosses(s, mode, mid)) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

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
    for (const mode of MODES) {
      const approx = minDistanceOf(s, mode);
      const flip = flipRadius(s, mode);
      const cells = flip === null
        ? `${fmt(approx - s.trueMin)} | 測定不能 | 測定不能`
        : `${fmt(approx - s.trueMin)} | ${fmt(flip - approx)} | ${fmt(flip - s.trueMin)}`;
      console.log(`${s.label} | ${mode} | ${cells}`);
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

  console.log('\n## 現状の刻みで出得る 歩/周回\n');
  stepsPerRevolution(buildEphemeris());
  console.log(`\n(最接近距離の参照は制御点から張った曲線の ${SAMPLES} 点サンプリング + 黄金分割。`
    + ' 真値は同じ運動を 4000 分割で積んだ経路の最小距離。)');
}

if (require.main === module) run();
