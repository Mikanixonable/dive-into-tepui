// 実シミュレーションと積分弧は、同じ問い(この物体にどの天体が効くか)へ別々の絞り込みで答える。
// 探し方が違うのは同時性から来る正当な差だが、答えが食い違ってよい理由はない。この2つの窓が
// 同じ位置・同じ時刻で一致することを、重力と表面判定の両方について固定する。
import { lagrangeOf, motionOf, orbitingMotionOf, solarSystemParts, stateOf } from './test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { attractorAccel } from '../../src/physics/attractor';
import { kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, MU_MOON, MU_SUN, R_EARTH, R_MOON } from '../../src/game/celestial/solar-system/constants';
import { add, addScaled, cross, len, norm, scale, sub, v3 } from '../../src/math/vec3';
import { stepDynamics } from '../../src/physics/dynamics';
import { ArcCelestialBodies, type FutureCelestialBodyProvider } from '../../src/game/dynamic/arc-celestial-bodies';
import { attractorsNearInto, classifyAttractors, GRAVITY_NEGLIGIBLE_ACCEL } from '../../src/game/dynamic/attractors';
import { SurfaceCandidates, type SurfaceParticipant } from '../../src/game/dynamic/surface-candidates';
import { CelestialMotion } from '../../src/physics/celestial-motion';
import type { KinematicState } from '../../src/physics/kinematic-state';
import type { Vec3 } from '../../src/math/vec3';
import { SUBSTEP_MAX_DT } from '../../src/game/dynamic/time-step';

// 比べる場所を決めるだけの、この試験の走査条件。自機の初期軌道と同じ高度・傾斜角、
// 半径は自機の剛体接触半径と同程度に取る。
const SITE_ALT = 420e3; // [m]
const SITE_INC_DEG = 97.0; // [deg]
const SITE_RADIUS = 2.6; // [m]

// 現実の太陽系・地球原点の既定の登録天体。両方の窓へ同じ天体一式を供給する。
const PARTS = solarSystemParts();
const WINDOWS = PARTS.system;

// 弧が候補として引く天体一式。実シミュレーション側の窓と同じ運動から組む。
const ARC_SOURCES: FutureCelestialBodyProvider = { celestialMotions: PARTS.system.celestialMotions };

const DAY = 86400;
// 天体の配置そのものが入れ替わるよう、数か月の間を置いた時刻でも見る。
const SAMPLE_TIMES: readonly number[] = [0, 90 * DAY, 200 * DAY];

// 検査する場所。位置も速度も天体の運動から導き、どこなのかが式から読めるようにする。
type Site = {
  readonly name: string;
  readonly stateAt: (t: number) => KinematicState;
};

// center のまわりの円軌道の状態。offset は center からの相対位置、normal は軌道面法線で、
// 両者は直交していなければならない。
function circularOrbitState(center: KinematicState, mu: number, offset: Vec3, normal: Vec3): KinematicState {
  const prograde = norm(cross(normal, offset));
  return kinematicState<'eci'>(center.t, add(center.r, offset), addScaled(center.v, prograde, Math.sqrt(mu / len(offset))));
}

const SITES: readonly Site[] = [
  {
    name: 'LEO',
    stateAt: (t) => {
      const r0 = R_EARTH + SITE_ALT;
      const inc = (SITE_INC_DEG * Math.PI) / 180;
      const speed = Math.sqrt(MU_EARTH / r0);
      return kinematicState<'eci'>(t, v3(r0, 0, 0), v3(0, speed * Math.sin(inc), -speed * Math.cos(inc)));
    },
  },
  {
    name: '低月周回軌道',
    // 月の反地球側 100km 上空を、白道面内で回る。
    stateAt: (t) => {
      const moon = stateOf(PARTS, 'moon', t);
      const offset = scale(norm(moon.r), R_MOON + 100e3);
      return circularOrbitState(moon, MU_MOON, offset, orbitingMotionOf(PARTS, 'moon').orbitNormalAt(t));
    },
  },
  {
    name: '太陽-地球L2',
    // L2 は地球と共に公転するので、速度はラグランジュ点そのものの時間微分になる。
    stateAt: (t) => {
      const dt = 1;
      const back = lagrangeOf(PARTS, 'earth', t - dt).L2;
      const fwd = lagrangeOf(PARTS, 'earth', t + dt).L2;
      return kinematicState<'eci'>(t, lagrangeOf(PARTS, 'earth', t).L2, scale(sub(fwd, back), 1 / (2 * dt)));
    },
  },
  {
    name: '主帯',
    // ケレスと同じ日心距離・同じ軌道面で、公転方向へ 90° 進んだ点。
    stateAt: (t) => {
      const sun = stateOf(PARTS, 'sun', t);
      const ceres = orbitingMotionOf(PARTS, 'ceres');
      const normal = ceres.orbitNormalAt(t);
      const offset = cross(normal, sub(stateOf(PARTS, 'ceres', t).r, sun.r));
      return circularOrbitState(sun, MU_SUN, offset, normal);
    },
  },
];

// 天体一式が位置 r へ及ぼす ECI 加速度の和。素の引力ではなく、運動方程式に実際に現れる寄与で
// 比べるために attractorAccel を使う。
function gravitySum(bodies: readonly CelestialMotion[], r: Vec3, t: number): Vec3 {
  return bodies.reduce((sum, body) => add(sum, attractorAccel(r, body, 0, t)), v3());
}

// bodies にあって others に無い天体を、その1体ぶんの寄与の大きさとともに並べた文字列。
function onlyIn(bodies: readonly CelestialMotion[], others: readonly CelestialMotion[], r: Vec3, t: number): string {
  const known = new Set(others.map((b) => b.id));
  const missing = bodies.filter((b) => !known.has(b.id))
    .map((b) => `${b.id}(${len(attractorAccel(r, b, 0, t)).toExponential(2)})`);
  return missing.length === 0 ? 'なし' : missing.join(', ');
}

// 実シミュレーションのサブステップ1回ぶんの区間。絞り込みは区間の両端を見るので、弧と同じ
// 刻みで実際に1歩積んだ結果を渡す。
function substepInterval(from: KinematicState, dt: number): SurfaceParticipant {
  const mid = WINDOWS.gravityMotions;
  return {
    prevState: from,
    state: stepDynamics(from, dt, mid, [], null, 0, 0, 0, null),
    radius: SITE_RADIUS,
  };
}

// 表面判定の相手を比べる場所。円軌道では1サブステップの間にどの表面へも届かないので、
// 絞り込みが実際に何かを通す「接触が差し迫った場所」でなければ比べる意味がない。
type SurfaceSite = { readonly name: string; readonly bodyId: string };

// 登録天体のうち μ が最も小さいもの。常時加算される重い天体から最も遠い側の経路
// (グリッドへ載る側・弧の成員から抜けやすい側)を通る相手として選ぶ。
function weakestGravityBodyId(): string {
  const defs = PARTS.bodies.map((m) => m.def).filter((b) => b.radius > 0);
  return defs.reduce((a, b) => (b.mu < a.mu ? b : a)).id;
}

const SURFACE_SITES: readonly SurfaceSite[] = [
  { name: '地球の表面直上', bodyId: 'earth' },
  { name: '月の表面直上', bodyId: 'moon' },
  { name: '最も軽い天体の表面直上', bodyId: weakestGravityBodyId() },
];

// bodyId の表面から 1km 上空を、表面へ向かって降りていく状態。向きは任意でよいので +X に取る。
function descentState(bodyId: string, t: number): KinematicState {
  const body = PARTS.system.motionOf(bodyId);
  const up = v3(1, 0, 0);
  return kinematicState<'eci'>(
    t,
    addScaled(body.stateAt(t).r, up, body.def.radius + 1e3),
    addScaled(body.stateAt(t).v, up, -100),
  );
}

export function register(): void {
  for (const site of SITES) {
    test(`gravity-window: ${site.name}で弧と実シミュレーションの重力和は GRAVITY_NEGLIGIBLE_ACCEL 以内で一致する`, () => {
      for (const t of SAMPLE_TIMES) {
        const from = site.stateAt(t);
        const sim = attractorsNearInto(from.r, classifyAttractors(WINDOWS.gravityMotions, 0), []);
        // 成員は最初の解決で確定するので、場所ごと・時刻ごとに弧を組み直す。
        const arc = new ArcCelestialBodies(ARC_SOURCES).resolve(t, from, 0).gravity;
        const diff = len(sub(gravitySum(sim, from.r, t), gravitySum(arc, from.r, t)));
        assert.ok(
          diff <= GRAVITY_NEGLIGIBLE_ACCEL,
          `${site.name} t=${t}: 重力和の差 ${diff.toExponential(3)} m/s²`
          + ` / 実シミュレーションにしかない天体: ${onlyIn(sim, arc, from.r, t)}`
          + ` / 弧にしかない天体: ${onlyIn(arc, sim, from.r, t)}`,
        );
      }
    });
  }

  for (const site of SURFACE_SITES) {
    test(`collision-window: ${site.name}で弧の表面判定の相手は実シミュレーションの絞り込みを覆う`, () => {
      for (const t of SAMPLE_TIMES) {
        const from = descentState(site.bodyId, t);
        const participant = substepInterval(from, SUBSTEP_MAX_DT);
        const candidates = new SurfaceCandidates();
        candidates.resetSpan(
          WINDOWS.celestialMotions, participant.prevState.t,
          participant.prevState.t, participant.state.t);
        candidates.narrow([participant]);
        const sim = candidates.into(participant, []);
        // 何も通らない場所で比べても意味がないので、絞り込みが実際に通していることを先に見る。
        assert.ok(sim.length > 0, `${site.name} t=${t}: 実シミュレーション側が1体も通していない`);
        // 成員は最初の解決で確定するので、場所ごと・時刻ごとに弧を組み直す。
        const arc = new ArcCelestialBodies(ARC_SOURCES)
          .resolve(t + SUBSTEP_MAX_DT / 2, from, SUBSTEP_MAX_DT).collision;
        const known = new Set(arc.map((b) => b.id));
        const dropped = sim.filter((b) => !known.has(b.id)).map((b) => b.id);
        assert.deepEqual(
          dropped, [],
          `${site.name} t=${t}: 弧だけが落とした天体: ${dropped.join(', ')}`
          + ` / 実シミュレーション ${sim.length} 体, 弧 ${arc.length} 体`,
        );
      }
    });
  }
}
