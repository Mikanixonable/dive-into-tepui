// 実験14: 再突入域の刻み細分化が支えている量の、刻み感度。
// 近地点を大気の中に置いた軌道で艦を1回降ろし、刻みの決め方を変えて次を並べる:
//   外殻温度の最大 / 動圧の最大(サンプルされた点値の最大)/ 限界を超えた時刻 / 最低高度。
// 位置と速度は RK4 で積むが、外殻温度は区間終端の1点をサンプルした一次(矩形)積分で、
// 動圧に至っては積分ですらなく点値である。生死を決めるのはその2つなので、刻み感度は
// 「RK4 の刻み感度」ではなく「一次積分と点サンプルの刻み感度」として現れる。
//
// 熱と動圧の式は player/thermal.ts の updateThermal の複製。原本は Hud を import するので
// tests/perf の tsconfig ではコンパイルできない。複製したのは次の3式で、定数は game/const
// からそのまま import している:
//   qdyn = 0.5 ρ s²
//   q̇    = SG_CONST √(ρ / NOSE_RADIUS) s³
//   T   += (q̇ · HEAT_ABSORB_AREA + cool) / heatCapacity · dtSub
//   cool = HULL_EMISS · STEFAN_BOLTZMANN · RAD_AREA · (ENV_TEMP⁴ − T⁴)
// ラジエーター(面積・太陽入射)と射撃・被弾の投入熱は 0 とする — 再突入の刻み感度を測る
// のに、刻みに依存しない項は要らない。
import { CelestialBody, nearestAtmosphereBody } from '../../src/physics/celestial-body';
import { airspeed, atmosphericDensity, ellipsoidAltitude } from '../../src/physics/atmosphere';
import { stepDynamics } from '../../src/physics/dynamics';
import { STEFAN_BOLTZMANN } from '../../src/physics/thermal';
import { Ephemeris } from '../../src/physics/ephemeris';
import { KinematicState, hermiteInterpolate, kinematicState } from '../../src/physics/kinematic-state';
import { len, sub, v3 } from '../../src/physics/vec3';
import * as C from '../../src/game/const';
import { simulationMaxStep } from '../../src/game/simulation/time-step';
import { MU_EARTH, R_EARTH, SHIP_BCINV, buildEphemeris } from './common';

const FRAME_DT = 1 / 60; // 60 fps を想定した実フレーム時間 [s]
const WARP = C.SIM_SPEED_LEVELS[C.SIM_SPEED_LEVELS.length - 1]!;
// 最高ワープの substep 幅。60 fps なら 34.13 s、フレーム時間が上限 0.1 s に張り付く低 fps
// では 13,107 / 64 = 204.8 s。
const WARP_STEP = simulationMaxStep(FRAME_DT * WARP, C.SUBSTEP_MAX_DT, C.SUBSTEP_MAX_COUNT);
const SLOW_FRAME_STEP = simulationMaxStep(0.1 * WARP, C.SUBSTEP_MAX_DT, C.SUBSTEP_MAX_COUNT);
const APOGEE_ALT = 413e3; // 出発する遠地点の高度 [m](初期軌道と同じ高さ)
const PERIGEE_ALT = 55e3; // 近地点の高度 [m]。ここを通ると加熱と動圧が限界に届く
const DURATION = 3000; // 1回の降下を追う時間 [s]。近地点通過を跨いで登り返すまで
const THERMAL_INNER_DT = 1; // 「熱だけ内側細分」案の内側刻み [s]

// 遠地点から出発する、近地点 PERIGEE_ALT の楕円。赤道面の順行に置く — 大気は自転する
// ので、対気速さがいちばん大きくなる置き方で測る。
function reentryState(): KinematicState {
  const ra = R_EARTH + APOGEE_ALT;
  const rp = R_EARTH + PERIGEE_ALT;
  return kinematicState(0, v3(ra, 0, 0), v3(0, Math.sqrt((2 * MU_EARTH * rp) / (ra * (ra + rp))), 0));
}

// 大気天体 body から測った高度 [m]。相手がいなければ Infinity。
function altitudeOf(state: KinematicState, body: CelestialBody | null): number {
  if (body === null || body.atmosphere === null) return Infinity;
  return ellipsoidAltitude(sub(state.r, body.state.r), body.atmosphere);
}

// その瞬間の大気密度 [kg/m³] と対気速さ [m/s]。thermal.ts の airflow と同じ。
function airflow(state: KinematicState, body: CelestialBody | null): { rho: number; speed: number } {
  if (body === null || body.atmosphere === null) return { rho: 0, speed: 0 };
  const rRel = sub(state.r, body.state.r);
  return {
    rho: atmosphericDensity(ellipsoidAltitude(rRel, body.atmosphere), body.atmosphere),
    speed: len(airspeed(rRel, sub(state.v, body.state.v), body.atmosphere)),
  };
}

// 外殻温度と動圧。ThermalSystem の状態のうち、刻みに依存する2つだけを持つ。
class Hull {
  temp = C.HULL_START_TEMP;
  qdyn = 0;

  // updateThermal の複製(ラジエーターと投入熱を 0 とした形)。state は区間終端。
  absorb(state: KinematicState, body: CelestialBody | null, dtSub: number): void {
    const { rho, speed: s } = airflow(state, body);
    this.qdyn = 0.5 * rho * s * s;
    const qdot = C.SG_CONST * Math.sqrt(rho / C.NOSE_RADIUS) * s * s * s;
    const cool = C.HULL_EMISS * STEFAN_BOLTZMANN * C.RAD_AREA
      * (Math.pow(C.ENV_TEMP, 4) - Math.pow(this.temp, 4));
    const heatCapacity = C.PLAYER_MASS * 100; // 比熱 約100 J/kg/K(thermal.ts と同じ)
    this.temp = Math.max(
      C.HULL_TEMP_FLOOR,
      this.temp + ((qdot * C.HEAT_ABSORB_AREA + cool) / heatCapacity) * dtSub);
  }
}

// 刻みの決め方。'fixed' は刻み固定、'inner' は熱と動圧だけを内側で細分する案(位置と速度は
// 粗い刻みのまま進める)。
type Scheme =
  | { readonly kind: 'fixed'; readonly step: number }
  | { readonly kind: 'inner'; readonly step: number };

interface Result {
  readonly maxTemp: number;    // 外殻温度の最大 [K]
  readonly maxQdyn: number;    // 動圧の最大(サンプルされた点値の最大)[Pa]
  readonly lost: string;       // 限界を超えた種別と時刻。超えなければ '—'
  readonly minAlt: number;     // 到達した最低高度 [m]
  readonly maxSpeed: number;   // 対気速さの最大 [m/s]。積分の破綻はここに真っ先に出る
  readonly steps: number;      // 位置・速度の積分歩数
  readonly thermalSteps: number; // 熱・動圧を評価した回数
}

// 1回の降下を追う。刻みは scheme が決め、熱と動圧は区間終端(inner なら内側の各点)で見る。
function descend(ephemeris: Ephemeris, scheme: Scheme): Result {
  const hull = new Hull();
  let state = reentryState();
  const end = state.t + DURATION;
  let maxTemp = hull.temp, maxQdyn = 0, maxSpeed = 0, minAlt = Infinity, steps = 0, thermalSteps = 0;
  let lost = '—';
  while (state.t < end) {
    const air = ephemeris.atmosphereCelestialBodiesAt(state.t);
    const body = nearestAtmosphereBody(state.r, air);
    const dt = Math.min(scheme.step, end - state.t);
    const tMid = state.t + dt / 2;
    const next = stepDynamics(
      state, dt, ephemeris.gravityAttractorsAt(tMid), ephemeris.celestialBodiesAt(tMid),
      nearestAtmosphereBody(state.r, ephemeris.atmosphereCelestialBodiesAt(tMid)),
      SHIP_BCINV, C.SHIP_SRP_COEFF, null);
    steps++;

    if (scheme.kind === 'inner') {
      // 区間の中を Hermite で埋め、熱と動圧だけを細かい刻みで積む。位置と速度は粗いまま。
      const inner = Math.max(1, Math.ceil(dt / THERMAL_INNER_DT));
      for (let i = 1; i <= inner; i++) {
        const at = hermiteInterpolate(state, next, state.t + (dt * i) / inner);
        hull.absorb(at, body, dt / inner);
        thermalSteps++;
        maxSpeed = Math.max(maxSpeed, airflow(at, body).speed);
        maxTemp = Math.max(maxTemp, hull.temp);
        maxQdyn = Math.max(maxQdyn, hull.qdyn);
      }
    } else {
      hull.absorb(next, body, dt);
      thermalSteps++;
      maxSpeed = Math.max(maxSpeed, airflow(next, body).speed);
      maxTemp = Math.max(maxTemp, hull.temp);
      maxQdyn = Math.max(maxQdyn, hull.qdyn);
    }

    state = next;
    minAlt = Math.min(minAlt, altitudeOf(state, body));
    if (lost === '—') {
      if (maxTemp > C.MAX_HULL_TEMP) lost = `熱防御飽和 t=${state.t.toFixed(0)} s`;
      else if (maxQdyn > C.MAX_DYN_PRESSURE) lost = `空力破壊 t=${state.t.toFixed(0)} s`;
    }
    if (minAlt <= 0) break; // 地表へ到達したらそこで終わり
  }
  return { maxTemp, maxQdyn, maxSpeed, lost, minAlt, steps, thermalSteps };
}

function row(label: string, r: Result): readonly string[] {
  return [
    label,
    r.maxTemp.toExponential(1),
    (r.maxQdyn / 1e3).toFixed(1),
    (r.maxSpeed / 1e3).toFixed(2),
    r.lost,
    (r.minAlt / 1e3).toFixed(1),
    `${r.steps.toLocaleString('en-US')} / ${r.thermalSteps.toLocaleString('en-US')}`,
  ];
}

export function run(): void {
  console.log('# 実験14: 再突入域の刻み細分化の、刻み感度\n');
  console.log(`遠地点 ${APOGEE_ALT / 1e3} km / 近地点 ${PERIGEE_ALT / 1e3} km の楕円を遠地点から`
    + `${DURATION} s 追う。限界は外殻温度 ${C.MAX_HULL_TEMP} K・動圧 ${C.MAX_DYN_PRESSURE / 1e3} kPa。\n`);
  const ephemeris = buildEphemeris();
  const schemes: readonly (readonly [string, Scheme])[] = [
    ['刻み 0.25 s 固定(基準 — 複製した熱の式が収束しているかの確認)', { kind: 'fixed', step: 0.25 }],
    ['刻み 1 s', { kind: 'fixed', step: 1 }],
    ['細分化なし・刻み 5 s', { kind: 'fixed', step: 5 }],
    ['細分化なし・刻み 10 s', { kind: 'fixed', step: 10 }],
    ['細分化なし・刻み 20 s(幅の上限)', { kind: 'fixed', step: C.SUBSTEP_MAX_DT }],
    [`細分化なし・刻み ${WARP_STEP.toFixed(2)} s(最高ワープ 60 fps)`,
      { kind: 'fixed', step: WARP_STEP }],
    [`細分化なし・刻み ${SLOW_FRAME_STEP.toFixed(1)} s(最高ワープ 低 fps)`,
      { kind: 'fixed', step: SLOW_FRAME_STEP }],
    [`熱だけ内側細分(位置は ${WARP_STEP.toFixed(2)} s、熱は ${THERMAL_INNER_DT} s)`,
      { kind: 'inner', step: WARP_STEP }],
  ];
  const header = ['刻みの決め方', '外殻温度の最大 [K]', '動圧の最大 [kPa]', '対気速さの最大 [km/s]',
    '限界超過', '最低高度 [km]', '積分歩数 / 熱の評価回数'];
  console.log(header.join(' | '));
  console.log(header.map(() => '---').join(' | '));
  for (const [label, scheme] of schemes) {
    console.log(row(label, descend(ephemeris, scheme)).join(' | '));
  }
}

if (require.main === module) run();
