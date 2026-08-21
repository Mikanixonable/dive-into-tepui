// 実シミュレーションと積分弧は、同じ問い(この物体にどの天体が効くか)へ別々の絞り込みで答える。
// 探し方が違うのは同時性から来る正当な差だが、答えが食い違ってよい理由はない。この2つの窓が
// 同じ位置・同じ時刻で一致することを、重力と表面判定の両方について固定する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { attractorAccel } from '../../src/physics/attractor';
import { Ephemeris } from '../../src/physics/ephemeris';
import { kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, MU_MOON, MU_SUN, R_EARTH, R_MOON } from '../../src/physics/solar-system';
import { add, addScaled, cross, len, norm, scale, sub, v3 } from '../../src/physics/vec3';
import { stepDynamics } from '../../src/physics/dynamics';
import {
  GRAVITY_NEGLIGIBLE_ACCEL, INITIAL_ALT, INITIAL_INC_DEG,
  PLAYER_HULL_RADIUS, SUBSTEP_MAX_DT,
} from '../../src/game/const';
import { ArcBodies } from '../../src/game/simulation/arc-bodies';
import { attractorsNearInto, classifyAttractors } from '../../src/game/simulation/attractors';
import { FutureAttractors } from '../../src/game/simulation/future-attractors';
import { SurfaceCandidates, type SurfaceParticipant } from '../../src/game/simulation/surface-candidates';
import type { Attractor, AttractorId } from '../../src/physics/attractor';
import type { KinematicState } from '../../src/physics/kinematic-state';
import type { Vec3 } from '../../src/physics/vec3';

// 現実の太陽系・地球原点の既定レジストリ。両方の窓へ同じ天体一式を供給する。
const EPHEMERIS = new Ephemeris();

const DAY = 86400;
// 天体の配置そのものが入れ替わるよう、数か月の間を置いた時刻でも見る。
const SAMPLE_TIMES: readonly number[] = [0, 90 * DAY, 200 * DAY];

// 検査する場所。位置も速度も天体暦から導き、どこなのかが式から読めるようにする。
type Site = {
  readonly name: string;
  readonly stateAt: (t: number) => KinematicState;
};

// center のまわりの円軌道の状態。offset は center からの相対位置、normal は軌道面法線で、
// 両者は直交していなければならない。
function circularOrbitState(center: KinematicState, mu: number, offset: Vec3, normal: Vec3): KinematicState {
  const prograde = norm(cross(normal, offset));
  return kinematicState(center.t, add(center.r, offset), addScaled(center.v, prograde, Math.sqrt(mu / len(offset))));
}

const SITES: readonly Site[] = [
  {
    name: 'LEO',
    // 自機の初期軌道と同じ高度・傾斜角の円軌道。
    stateAt: (t) => {
      const r0 = R_EARTH + INITIAL_ALT;
      const inc = (INITIAL_INC_DEG * Math.PI) / 180;
      const speed = Math.sqrt(MU_EARTH / r0);
      return kinematicState(t, v3(r0, 0, 0), v3(0, speed * Math.sin(inc), -speed * Math.cos(inc)));
    },
  },
  {
    name: '低月周回軌道',
    // 月の反地球側 100km 上空を、白道面内で回る。
    stateAt: (t) => {
      const moon = EPHEMERIS.stateOf('moon', t);
      const offset = scale(norm(moon.r), R_MOON + 100e3);
      return circularOrbitState(moon, MU_MOON, offset, EPHEMERIS.orbitNormalAt('moon', t));
    },
  },
  {
    name: '太陽-地球L2',
    // L2 は地球と共に公転するので、速度はラグランジュ点そのものの時間微分になる。
    stateAt: (t) => {
      const dt = 1;
      const back = EPHEMERIS.lagrangeAt('earth', t - dt).L2;
      const fwd = EPHEMERIS.lagrangeAt('earth', t + dt).L2;
      return kinematicState(t, EPHEMERIS.lagrangeAt('earth', t).L2, scale(sub(fwd, back), 1 / (2 * dt)));
    },
  },
  {
    name: '主帯',
    // ケレスと同じ日心距離・同じ軌道面で、公転方向へ 90° 進んだ点。
    stateAt: (t) => {
      const sun = EPHEMERIS.stateOf('sun', t);
      const normal = EPHEMERIS.orbitNormalAt('ceres', t);
      const offset = cross(normal, sub(EPHEMERIS.positionOf('ceres', t), sun.r));
      return circularOrbitState(sun, MU_SUN, offset, normal);
    },
  },
];

// 天体一式が位置 r へ及ぼす ECI 加速度の和。素の引力ではなく、運動方程式に実際に現れる寄与で
// 比べるために attractorAccel を使う。
function gravitySum(bodies: readonly Attractor[], r: Vec3, t: number): Vec3 {
  return bodies.reduce((sum, body) => add(sum, attractorAccel(r, body, t)), v3());
}

// bodies にあって others に無い天体を、その1体ぶんの寄与の大きさとともに並べた文字列。
function onlyIn(bodies: readonly Attractor[], others: readonly Attractor[], r: Vec3, t: number): string {
  const known = new Set(others.map((b) => b.id));
  const missing = bodies.filter((b) => !known.has(b.id))
    .map((b) => `${b.id}(${len(attractorAccel(r, b, t)).toExponential(2)})`);
  return missing.length === 0 ? 'なし' : missing.join(', ');
}

// 実シミュレーションのサブステップ1回ぶんの区間。絞り込みは区間の両端を見るので、弧と同じ
// 刻みで実際に1歩積んだ結果を渡す。
function substepInterval(from: KinematicState, dt: number): SurfaceParticipant {
  const mid = EPHEMERIS.gravityAttractorsAt(from.t + dt / 2);
  return {
    prevState: from,
    state: stepDynamics(from, dt, mid, [], null, 0, 0, null),
    radius: PLAYER_HULL_RADIUS,
  };
}

// 表面判定の相手を比べる場所。円軌道では1サブステップの間にどの表面へも届かないので、
// 絞り込みが実際に何かを通す「接触が差し迫った場所」でなければ比べる意味がない。
type SurfaceSite = { readonly name: string; readonly bodyId: AttractorId };

// レジストリで最初に見つかる、重力を及ぼさないが半径を持つ天体。表面判定が重力の有無に
// 依らないことは、この種の天体でしか見えない。
function firstMasslessBodyId(): AttractorId {
  const def = Object.values(EPHEMERIS.registry).find((b) => b.mu === 0 && b.radius > 0);
  assert.ok(def !== undefined, '既定レジストリに mu=0 の天体が無い');
  return def!.id;
}

const SURFACE_SITES: readonly SurfaceSite[] = [
  { name: '地球の表面直上', bodyId: 'earth' },
  { name: '月の表面直上', bodyId: 'moon' },
  { name: '重力を持たない天体の表面直上', bodyId: firstMasslessBodyId() },
];

// bodyId の表面から 1km 上空を、表面へ向かって降りていく状態。向きは任意でよいので +X に取る。
function descentState(bodyId: AttractorId, t: number): KinematicState {
  const body = EPHEMERIS.attractorAt(bodyId, t);
  const up = v3(1, 0, 0);
  return kinematicState(
    t,
    addScaled(body.state.r, up, body.radius + 1e3),
    addScaled(body.state.v, up, -100),
  );
}

export function register(): void {
  const arcSources = new FutureAttractors(EPHEMERIS);
  for (const site of SITES) {
    test(`gravity-window: ${site.name}で弧と実シミュレーションの重力和は GRAVITY_NEGLIGIBLE_ACCEL 以内で一致する`, () => {
      for (const t of SAMPLE_TIMES) {
        const from = site.stateAt(t);
        const sim = attractorsNearInto(from.r, classifyAttractors(EPHEMERIS.gravityAttractorsAt(t)), []);
        // 成員は最初の解決で確定するので、場所ごと・時刻ごとに弧を組み直す。
        const arc = new ArcBodies(arcSources).resolve(t, from, 0).gravity;
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
        candidates.reset([participant], EPHEMERIS.attractorsAt(t));
        const sim = candidates.into(participant, []);
        // 何も通らない場所で比べても意味がないので、絞り込みが実際に通していることを先に見る。
        assert.ok(sim.length > 0, `${site.name} t=${t}: 実シミュレーション側が1体も通していない`);
        // 成員は最初の解決で確定するので、場所ごと・時刻ごとに弧を組み直す。
        const arc = new ArcBodies(arcSources)
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
