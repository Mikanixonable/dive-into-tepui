// 実験15: 再突入で軌道 RK4 が壊れる条件の切り分けと、大気の刻み規則の較正。
// exp14 は「熱と動圧の刻み感度」を測って壊れ方に行き当たったが、壊れているのが RK4 の側で
// あることまでしか分からなかった。
//
// **壊れる条件は「ある段の抗力が、その段の対気速度を1歩で奪い切る」ことである。** 比
// (|a_drag|·dt / |v_air|)が 1 を超えた段は、対気速度を消し切って押し返している。抗力が
// 速さの2乗に比例するため、そこから段どうしが増幅し合って1歩で発散する。
// `dragAccel` はこの比を 1 で頭打ちにするので、いま発散そのものは起きない — したがって
// ここで測るのは**発散の有無ではなく、頭打ちに触れたかどうか**である。触れた歩は、頭打ちが
// 無ければ発散していた歩にあたる。
//
//   表1: どの力が比を 1 へ押し上げるか(抗力を切ると触れなくなるか)
//   表2: 触れた歩で RK4 の4段が実際に何を標本しているか
//   表3: 軌道の族での較正 — 剛性だけ・沈み込みだけでは足りないこと、定数を縛るのは
//        安定性ではなく精度であること
//   表4: 最高ワープ1フレームのサブステップ数が細分で増えないこと
//
// 熱と動圧の式は player/thermal.ts の updateThermal の複製(原本は Hud を import するので
// tests/perf の tsconfig ではコンパイルできない)。ラジエーターと投入熱は 0 とする。
//   qdyn = 0.5 ρ s²
//   q̇    = SG_CONST √(ρ / NOSE_RADIUS) s³
//   T   += (q̇ · HEAT_ABSORB_AREA + cool) / heatCapacity · dtSub
//   cool = HULL_EMISS · STEFAN_BOLTZMANN · RAD_AREA · (ENV_TEMP⁴ − T⁴)
import { CelestialBody, attractorAccel, nearestAtmosphereBody } from '../../src/physics/celestial-body';
import {
  Atmosphere, airspeed, atmosphericDensity, atmosphericScaleHeight, dragAccel, ellipsoidAltitude,
} from '../../src/physics/atmosphere';
import { degree2Accel, stepDynamics } from '../../src/physics/dynamics';
import { STEFAN_BOLTZMANN } from '../../src/physics/thermal';
import { Ephemeris } from '../../src/physics/ephemeris';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { Vec3, add, dot, len, sub, v3 } from '../../src/physics/vec3';
import * as C from '../../src/game/const';
import { atmosphericMaxStep, simulationMaxStep } from '../../src/game/simulation/time-step';
import { MU_EARTH, R_EARTH, SHIP_BCINV, buildEphemeris } from './common';

// 段の比 |a_drag|·dt / |v_air| がこれを超えると、その段は対気速度を消し切って押し返している。
// dragAccel はこの値で頭打ちにする。
const REVERSAL = 1;
const WARP = C.SIM_SPEED_LEVELS[C.SIM_SPEED_LEVELS.length - 1]!;
const SLOW_FRAME_DT = 0.1; // フレーム時間の上限。最高ワープでの1フレームがいちばん長くなる
const WARP_STEP = simulationMaxStep(SLOW_FRAME_DT * WARP, C.SUBSTEP_MAX_DT, C.SUBSTEP_MAX_COUNT);

// 遠地点 apo / 近地点 peri(ともに基準楕円体からの高度 [m])の楕円を、遠地点から。
// 赤道面の順行に置く — 大気は自転するので、対気速さがいちばん大きくなる置き方で測る。
function apsisState(apo: number, peri: number): KinematicState {
  const ra = R_EARTH + apo;
  const rp = R_EARTH + peri;
  return kinematicState(0, v3(ra, 0, 0), v3(0, Math.sqrt((2 * MU_EARTH * rp) / (ra * (ra + rp))), 0));
}

// 天体 body から測った高度 [m]・大気密度 [kg/m³]・対気速さ [m/s]。
function airflow(s: KinematicState, body: CelestialBody):
{ alt: number; rho: number; speed: number } {
  const atm = body.atmosphere!;
  const rRel = sub(s.r, body.state.r);
  const alt = ellipsoidAltitude(rRel, atm);
  return {
    alt,
    rho: atmosphericDensity(alt, atm),
    speed: len(airspeed(rRel, sub(s.v, body.state.v), atm)),
  };
}

// 外殻温度の一次(矩形)積分。updateThermal の複製。
function absorbHeat(temp: number, rho: number, speed: number, dt: number): number {
  const qdot = C.SG_CONST * Math.sqrt(rho / C.NOSE_RADIUS) * speed * speed * speed;
  const cool = C.HULL_EMISS * STEFAN_BOLTZMANN * C.RAD_AREA
    * (Math.pow(C.ENV_TEMP, 4) - Math.pow(temp, 4));
  return Math.max(
    C.HULL_TEMP_FLOOR,
    temp + ((qdot * C.HEAT_ABSORB_AREA + cool) / (C.PLAYER_MASS * 100)) * dt);
}

// 刻みの決め方。'fixed' は刻み固定、'rule' は大気の上限を cap と併せて使う。
// ratio / scaleHeights を Infinity にすると、その上限だけを外して測れる。
type Scheme =
  | { readonly kind: 'fixed'; readonly dt: number }
  | { readonly kind: 'rule'; readonly cap: number; readonly ratio: number; readonly scaleHeights: number };

// atmosphericMaxStep と同じ式。定数を実験側から差し替えられるようにするためだけの複製で、
// ratio = DRAG_STEP_MAX_SPEED_LOSS・scaleHeights = DRAG_STEP_MAX_SCALE_HEIGHTS のとき
// 本体と一致する(表3の「規則(本体の定数)」行がその確認)。
function ruleStep(s: KinematicState, body: CelestialBody, ratio: number, scaleHeights: number): number {
  const atm: Atmosphere = body.atmosphere!;
  const rRel = sub(s.r, body.state.r);
  const vRel = sub(s.v, body.state.v);
  const d = len(rRel);
  const { alt, rho, speed } = airflow(s, body);
  const lambda = 0.5 * rho * speed * SHIP_BCINV;
  const stiff = lambda > 0 && isFinite(ratio) ? ratio / lambda : Infinity;
  if (!isFinite(scaleHeights)) return stiff;
  const depth = scaleHeights * atmosphericScaleHeight(alt, atm);
  const descentRate = Math.max(0, -dot(rRel, vRel) / d);
  const g = body.mu / (d * d);
  const sink = (2 * depth) / (descentRate + Math.sqrt(descentRate * descentRate + 2 * g * depth));
  return Math.min(stiff, sink);
}

interface Descent {
  readonly steps: number;
  readonly maxTemp: number;
  readonly maxQdyn: number;
  readonly maxSpeed: number;
  readonly minAlt: number;
  readonly maxReversal: number; // 全歩・全段での比の最大。1 を超えたら頭打ちに触れている
}

// 位置 r・速度 v にいる物体が、刻み dt のあいだに抗力で失う対気速度の割合(頭打ち前)。
function reversalRatio(r: Vec3, v: Vec3, body: CelestialBody, bcInv: number, dt: number): number {
  const atm = body.atmosphere!;
  const rRel = sub(r, body.state.r);
  const speed = len(airspeed(rRel, sub(v, body.state.v), atm));
  if (speed <= 0) return 0;
  return 0.5 * atmosphericDensity(ellipsoidAltitude(rRel, atm), atm) * speed * bcInv * dt;
}

// RK4 の4段が標本する点での、高度・比(頭打ち前)・実際に効いた抗力。
interface Stages { readonly alts: number[]; readonly ratios: number[]; readonly drags: number[] }

function stages(eph: Ephemeris, s: KinematicState, dt: number, body: CelestialBody): Stages {
  const t = s.t + dt / 2;
  const attractors = eph.gravityAttractorsAt(t);
  const at = (r: Vec3, v: Vec3): { a: Vec3; alt: number; ratio: number; drag: number } => {
    let g = v3();
    for (const b of attractors) {
      g = add(g, attractorAccel(r, b, t));
      if (b.degree2 !== null) g = add(g, degree2Accel(sub(r, b.state.r), b.mu, b.degree2));
    }
    const d = dragAccel(sub(r, body.state.r), sub(v, body.state.v), SHIP_BCINV, body.atmosphere!, dt);
    return {
      a: add(g, d),
      alt: ellipsoidAltitude(sub(r, body.state.r), body.atmosphere!),
      ratio: reversalRatio(r, v, body, SHIP_BCINV, dt),
      drag: len(d),
    };
  };
  const h = dt / 2;
  const k1 = at(s.r, s.v);
  const r2 = add(s.r, v3(s.v.x * h, s.v.y * h, s.v.z * h));
  const v2 = add(s.v, v3(k1.a.x * h, k1.a.y * h, k1.a.z * h));
  const k2 = at(r2, v2);
  const r3 = add(s.r, v3(v2.x * h, v2.y * h, v2.z * h));
  const v3s = add(s.v, v3(k2.a.x * h, k2.a.y * h, k2.a.z * h));
  const k3 = at(r3, v3s);
  const r4 = add(s.r, v3(v3s.x * dt, v3s.y * dt, v3s.z * dt));
  const v4 = add(s.v, v3(k3.a.x * dt, k3.a.y * dt, k3.a.z * dt));
  const k4 = at(r4, v4);
  const all = [k1, k2, k3, k4];
  return { alts: all.map((k) => k.alt), ratios: all.map((k) => k.ratio), drags: all.map((k) => k.drag) };
}

// 遠地点から duration 秒ぶん降下を追う。forces を落とすと、その力を外して積める。
interface Forces { readonly drag: boolean; readonly degree2: boolean; readonly srp: boolean }
const ALL_FORCES: Forces = { drag: true, degree2: true, srp: true };

function descend(
  eph: Ephemeris, start: KinematicState, duration: number, scheme: Scheme, forces = ALL_FORCES,
): Descent {
  let s = start;
  const end = start.t + duration;
  let steps = 0, maxTemp = C.HULL_START_TEMP, temp = maxTemp, maxQdyn = 0, maxSpeed = 0;
  let minAlt = Infinity, maxReversal = 0;
  while (s.t < end && steps < 500_000) {
    const air = eph.atmosphereCelestialBodiesAt(s.t);
    const body = nearestAtmosphereBody(s.r, air)!;
    const want = scheme.kind === 'fixed'
      ? scheme.dt
      : Math.min(scheme.cap, ruleStep(s, body, scheme.ratio, scheme.scaleHeights));
    const dt = Math.min(want, end - s.t);
    if (!(dt > 1e-9)) break;
    if (forces.drag) maxReversal = Math.max(maxReversal, ...stages(eph, s, dt, body).ratios);
    const tMid = s.t + dt / 2;
    const attractors = forces.degree2
      ? eph.gravityAttractorsAt(tMid)
      : eph.gravityAttractorsAt(tMid).map((a) => ({ ...a, degree2: null }));
    s = stepDynamics(
      s, dt, attractors, eph.celestialBodiesAt(tMid),
      forces.drag ? body : null, forces.drag ? SHIP_BCINV : 0,
      forces.srp ? C.SHIP_SRP_COEFF : 0, null);
    steps++;
    if (!isFinite(s.r.x)) break;
    const { alt, rho, speed } = airflow(s, body);
    temp = absorbHeat(temp, rho, speed, dt);
    maxTemp = Math.max(maxTemp, temp);
    maxQdyn = Math.max(maxQdyn, 0.5 * rho * speed * speed);
    maxSpeed = Math.max(maxSpeed, speed);
    minAlt = Math.min(minAlt, alt);
    if (alt <= 0) break;
  }
  return { steps, maxTemp, maxQdyn, maxSpeed, minAlt, maxReversal };
}

// ---- 表の出力 ----

function table(header: readonly string[], rows: readonly (readonly string[])[]): void {
  console.log(header.join(' | '));
  console.log(header.map(() => '---').join(' | '));
  for (const r of rows) console.log(r.join(' | '));
  console.log('');
}

function descentRow(label: string, r: Descent, ref: Descent | null): readonly string[] {
  const pct = (x: number, base: number): string =>
    base === 0 ? '—' : `${x > base ? '+' : ''}${(((x - base) / base) * 100).toFixed(1)}%`;
  return [
    label,
    r.steps.toLocaleString('en-US'),
    (r.maxSpeed / 1e3).toFixed(2),
    r.maxReversal > REVERSAL ? `**${r.maxReversal.toExponential(1)}**` : r.maxReversal.toFixed(3),
    ref === null ? r.maxTemp.toExponential(2) : `${r.maxTemp.toFixed(0)} (${pct(r.maxTemp, ref.maxTemp)})`,
    ref === null ? (r.maxQdyn / 1e3).toFixed(1) : `${(r.maxQdyn / 1e3).toFixed(1)} (${pct(r.maxQdyn, ref.maxQdyn)})`,
    isFinite(r.minAlt) ? (r.minAlt / 1e3).toFixed(1) : '—',
  ];
}

const DESCENT_HEADER = ['刻みの決め方', '歩数', '対気速さ最大 [km/s]', '段の比の最大',
  '外殻温度の最大 [K]', '動圧の最大 [kPa]', '最低高度 [km]'];

interface Orbit { readonly label: string; readonly apo: number; readonly peri: number; readonly duration: number }
const ORBITS: readonly Orbit[] = [
  { label: '413 / 55 km', apo: 413e3, peri: 55e3, duration: 3000 },
  { label: '413 / 80 km', apo: 413e3, peri: 80e3, duration: 4000 },
  { label: '413 / 0 km', apo: 413e3, peri: 0, duration: 3000 },
  { label: '413 / −200 km(直撃)', apo: 413e3, peri: -200e3, duration: 3000 },
  { label: '2,000 / 60 km', apo: 2000e3, peri: 60e3, duration: 6000 },
  { label: '35,786 / 55 km(GTO)', apo: 35786e3, peri: 55e3, duration: 30000 },
];

function forceIsolation(eph: Ephemeris): void {
  console.log('## 表1: どの力が比を 1 へ押し上げるか(413 / 55 km、刻み固定)\n');
  console.log('「段の比の最大」が 1 を超えた行は、頭打ちが無ければ発散していた。'
    + '抗力を切った行だけが 0 のままになる。\n');
  const rows: string[][] = [];
  for (const dt of [20, WARP_STEP]) {
    for (const [name, f] of [
      ['全力', ALL_FORCES],
      ['抗力なし', { ...ALL_FORCES, drag: false }],
      ['2次重力場なし', { ...ALL_FORCES, degree2: false }],
      ['太陽輻射圧なし', { ...ALL_FORCES, srp: false }],
    ] as const) {
      const r = descend(eph, apsisState(413e3, 55e3), 3000, { kind: 'fixed', dt }, f);
      rows.push([`刻み ${dt.toFixed(1)} s・${name}`, ...descentRow('', r, null).slice(1)]);
    }
  }
  table(DESCENT_HEADER, rows);
}

function stageSampling(eph: Ephemeris): void {
  console.log('## 表2: 最初に比が 1 を超えた歩で、RK4 の4段が何を標本しているか\n');
  console.log('段の位置は現在の速度と加速度からの直線外挿なので、重力だけで動径方向に g·dt²/4 沈む。'
    + '**k1 の比(= λ·dt)が小さくても、沈んだ先で段の比が桁違いに跳ねる。**\n');
  const rows: string[][] = [];
  for (const dt of [WARP_STEP, 34.13, 20]) {
    let s = apsisState(413e3, 55e3);
    let hit: string[] | null = null;
    for (let i = 0; i < 500 && isFinite(s.r.x); i++) {
      const air = eph.atmosphereCelestialBodiesAt(s.t);
      const body = nearestAtmosphereBody(s.r, air)!;
      const { alt } = airflow(s, body);
      if (alt <= 0) break;
      const st = stages(eph, s, dt, body);
      if (Math.max(...st.ratios) > REVERSAL) {
        hit = [
          `刻み ${dt.toFixed(2)} s`,
          `${(alt / 1e3).toFixed(1)} km`,
          st.ratios[0]!.toFixed(3),
          st.alts.map((a, k) => `k${k + 1} ${(a / 1e3).toFixed(1)}km/${st.ratios[k]!.toExponential(1)}`).join('  '),
        ];
        break;
      }
      s = stepDynamics(
        s, dt, eph.gravityAttractorsAt(s.t + dt / 2), eph.celestialBodiesAt(s.t + dt / 2),
        body, SHIP_BCINV, C.SHIP_SRP_COEFF, null);
    }
    rows.push(hit ?? [`刻み ${dt.toFixed(2)} s`, '—(触れず)', '—', '—']);
  }
  table(['刻み', 'その歩の高度', 'k1 の比(= λ·dt)', '各段の 高度/比'], rows);
}

function calibration(eph: Ephemeris): void {
  console.log('## 表3: 軌道の族での較正\n');
  console.log('「剛性だけ」「沈み込みだけ」は片方の上限を外したもの。段の比が 1 を超えた行は、'
    + '頭打ちが無ければ発散していた — 頭打ちがあっても答えは正しくならない(誤差の桁を見よ)。'
    + `基準は刻み 0.25 s 固定。上限は ${WARP_STEP.toFixed(1)} s(最高ワープ・低 fps の刻み)。\n`);
  const cap = WARP_STEP;
  const schemes: readonly (readonly [string, Scheme])[] = [
    ['規則(本体の定数)',
      { kind: 'rule', cap, ratio: C.DRAG_STEP_MAX_SPEED_LOSS, scaleHeights: C.DRAG_STEP_MAX_SCALE_HEIGHTS }],
    ['規則 ratio=1 N=1', { kind: 'rule', cap, ratio: 1, scaleHeights: 1 }],
    ['規則 ratio=2 N=2', { kind: 'rule', cap, ratio: 2, scaleHeights: 2 }],
    ['剛性だけ(沈み込みを外す)', { kind: 'rule', cap, ratio: C.DRAG_STEP_MAX_SPEED_LOSS, scaleHeights: Infinity }],
    ['沈み込みだけ(剛性を外す)', { kind: 'rule', cap, ratio: Infinity, scaleHeights: C.DRAG_STEP_MAX_SCALE_HEIGHTS }],
    ['上限だけ(規則なし)', { kind: 'fixed', dt: cap }],
  ];
  for (const o of ORBITS) {
    console.log(`### 遠地点 / 近地点 ${o.label}(${o.duration} s 追跡)\n`);
    const ref = descend(eph, apsisState(o.apo, o.peri), o.duration, { kind: 'fixed', dt: 0.25 });
    const rows = [descentRow('刻み 0.25 s 固定(基準)', ref, null)];
    for (const [label, scheme] of schemes) {
      rows.push(descentRow(label, descend(eph, apsisState(o.apo, o.peri), o.duration, scheme), ref));
    }
    table(DESCENT_HEADER, rows);
  }
}

function substepCount(eph: Ephemeris): void {
  console.log('## 表4: 最高ワープ1フレームのサブステップ数\n');
  console.log(`1フレームの時間送り ${(SLOW_FRAME_DT * WARP).toFixed(0)} s。大域サブステップは`
    + `${C.SUBSTEP_MAX_COUNT} 歩(= SUBSTEP_MAX_COUNT)で、細分はその内側に閉じる。\n`);
  const simDt = SLOW_FRAME_DT * WARP;
  const rows: string[][] = [];
  let s = apsisState(413e3, 55e3);
  for (const target of [300e3, 200e3, 150e3, 100e3, 60e3, 40e3, 20e3, 5e3]) {
    // 目標高度まで細かい刻みで降ろしてから、その高度での要求を読む。
    for (let i = 0; i < 200_000; i++) {
      const air = eph.atmosphereCelestialBodiesAt(s.t);
      const body = nearestAtmosphereBody(s.r, air)!;
      if (airflow(s, body).alt <= target) break;
      s = stepDynamics(
        s, 1, eph.gravityAttractorsAt(s.t + 0.5), eph.celestialBodiesAt(s.t + 0.5),
        body, SHIP_BCINV, C.SHIP_SRP_COEFF, null);
    }
    const air = eph.atmosphereCelestialBodiesAt(s.t);
    const inner = atmosphericMaxStep(s, SHIP_BCINV, air);
    const outer = simulationMaxStep(simDt, C.SUBSTEP_MAX_DT, C.SUBSTEP_MAX_COUNT);
    rows.push([
      (target / 1e3).toFixed(0),
      inner.toFixed(2),
      Math.ceil(simDt / outer).toLocaleString('en-US'),
      Math.ceil(simDt / Math.min(outer, inner)).toLocaleString('en-US'),
      Math.ceil(simDt / 1).toLocaleString('en-US'),
    ]);
  }
  table(['高度 [km]', '大気が要求する刻み [s]', '大域サブステップ', '細分する個体の歩数',
    '(参考)高度 200 km 以下 1 s のとき'], rows);
}

export function run(): void {
  console.log('# 実験15: 再突入で軌道 RK4 が発散する原因と、大気の刻み規則の較正\n');
  const eph = buildEphemeris();
  forceIsolation(eph);
  stageSampling(eph);
  calibration(eph);
  substepCount(eph);
}

if (require.main === module) run();
