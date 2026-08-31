// 実験8: Simulator のサブステップ幅を粗くしたとき、軌道がどれだけ崩れるか。
//
// 1フレームに許すサブステップ数の上限 K を入れると、×65536 の刻み幅は 6553.6/K [s] になる。
// K ごとの刻み幅で1日ぶん積分し、細かい基準積分との差を「軌道要素の動き」として読む —
// マップで見えるのは形なので、位置の誤差そのものより長半径・近地点高度・傾斜角のずれが判断材料。
import { Ephemeris } from '../../src/physics/ephemeris';
import { orbitalElementsOf, strongestAttractor } from '../../src/physics/celestial-body';
import { apsisAltitudes } from '../../src/physics/elements';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/math/vec3';
import { MU_MOON, R_MOON } from '../../src/physics/solar-system/constants';
import {
  MU_EARTH, R_EARTH, SUBSTEP_MAX_DT,
  buildEphemeris, initialLeoState, integrateFixedDt, posError,
} from './common';

// ×65536 の1フレームの時間送り [s](dt = 0.1 s × warp)。
const SIM_DT_AT_TOP_WARP = 0.1 * 65536;

type Elements = { a: number; peAlt: number; apAlt: number; incDeg: number };

// 中心天体まわりの軌道要素を、比較に使う4つの量へ落とす。
function elementsOf(ephemeris: Ephemeris, s: KinematicState): Elements {
  const center = strongestAttractor(s.r, ephemeris.gravityAttractorsAt(s.t));
  const el = orbitalElementsOf(s, center);
  if (el === null) return { a: NaN, peAlt: NaN, apAlt: NaN, incDeg: NaN };
  const { pe, ap } = apsisAltitudes(el);
  return { a: el.a, peAlt: pe, apAlt: ap, incDeg: el.incDeg };
}

type OrbitCase = { label: string; state0: KinematicState; period: number };

function leoCase(): OrbitCase {
  const r0 = R_EARTH + 420e3;
  return {
    label: 'LEO 420km',
    state0: initialLeoState(),
    period: 2 * Math.PI * Math.sqrt(r0 ** 3 / MU_EARTH),
  };
}

function molniyaCase(): OrbitCase {
  const rp = R_EARTH + 500e3;
  const a = 26_600e3;
  const vp = Math.sqrt(MU_EARTH * (2 / rp - 1 / a));
  const inc = (63.4 * Math.PI) / 180;
  return {
    label: 'モルニヤ e=0.74',
    state0: kinematicState(0, v3(rp, 0, 0), v3(0, vp * Math.sin(inc), -vp * Math.cos(inc))),
    period: 2 * Math.PI * Math.sqrt(a ** 3 / MU_EARTH),
  };
}

function lunarCase(ephemeris: Ephemeris): OrbitCase {
  const moon = ephemeris.stateOf('moon', 0);
  const r0 = R_MOON + 100e3;
  const v = Math.sqrt(MU_MOON / r0);
  return {
    label: '低月周回 100km',
    state0: kinematicState(0, v3(moon.r.x + r0, moon.r.y, moon.r.z), v3(moon.v.x, moon.v.y + v, moon.v.z)),
    period: 2 * Math.PI * Math.sqrt(r0 ** 3 / MU_MOON),
  };
}

const km = (m: number) => (m / 1e3).toFixed(2);

export function run(): void {
  console.log('# 実験8: サブステップ幅と軌道の崩れ\n');
  const ephemeris = buildEphemeris();
  const day = 86400;
  const counts = [328, 256, 128, 64, 32, 16];

  for (const c of [leoCase(), molniyaCase(), lunarCase(ephemeris)]) {
    console.log(`\n## ${c.label}(周期 ${c.period.toFixed(0)}s、1日 = ${(day / c.period).toFixed(1)}周)\n`);
    const ref = integrateFixedDt(ephemeris, c.state0, 1, day);
    const refEl = elementsOf(ephemeris, ref);
    console.log(`  基準(dt=1s): a=${km(refEl.a)}km Pe=${km(refEl.peAlt)}km Ap=${km(refEl.apAlt)}km inc=${refEl.incDeg.toFixed(4)}°`);
    console.log('\n  K | 刻み [s] | 1周あたり歩数 | 位置差 [km] | Δa [km] | ΔPe [km] | ΔAp [km] | Δinc [°]');
    console.log('  --- | --- | --- | --- | --- | --- | --- | ---');
    for (const k of counts) {
      const dt = Math.max(SUBSTEP_MAX_DT, SIM_DT_AT_TOP_WARP / k);
      const s = integrateFixedDt(ephemeris, c.state0, dt, day);
      const el = elementsOf(ephemeris, s);
      console.log(
        `  ${k} | ${dt.toFixed(1)} | ${(c.period / dt).toFixed(1)}`
        + ` | ${km(posError(s, ref))} | ${km(el.a - refEl.a)} | ${km(el.peAlt - refEl.peAlt)}`
        + ` | ${km(el.apAlt - refEl.apAlt)} | ${(el.incDeg - refEl.incDeg).toFixed(4)}`,
      );
    }
  }
}

if (require.main === module) run();
