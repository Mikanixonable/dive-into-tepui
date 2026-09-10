// 重力源の絞り込み(game/dynamic/attractors.ts)の回帰テスト。絞り込みが落とした天体の寄与の和が
// GRAVITY_NEGLIGIBLE_ACCEL に収まること — 絞り込んだ一覧の重力和が全重力源の重力和と一致すること —
// を、地球圏・月圏・木星圏の実際の配置で固定する。
import { solarSystemParts } from '../physics/test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { attractorAccel } from '../../src/physics/attractor';
import { R_EARTH } from '../../src/game/celestial/solar-system/constants';
import { add, addScaled, len, sub, v3 } from '../../src/math/vec3';
import {
  attractorsNearInto, classifyAttractors, GRAVITY_NEGLIGIBLE_ACCEL,
} from '../../src/game/dynamic/attractors';
import type { CelestialBody } from '../../src/physics/celestial-body';
import type { Vec3 } from '../../src/math/vec3';

// 現実の太陽系・地球原点の既定の登録天体。
const SYSTEM = solarSystemParts().system;

const DAY = 86400;
// 天体の配置そのものが入れ替わるよう、数か月の間を置いた時刻でも見る。
const SAMPLE_TIMES: readonly number[] = [0, 90 * DAY, 200 * DAY];

const X_AXIS = v3(1, 0, 0);

// 検査する場所。位置は天体の運動から導き、どこなのかが式から読めるようにする。
type Site = {
  readonly name: string;
  readonly positionAt: (t: number) => Vec3;
};

// 天体 id の時刻 t の位置から +X 方向へ、天体の半径 + altitude [m] だけ離れた点。
function aboveSurface(id: string, altitude: number, t: number): Vec3 {
  const motion = SYSTEM.motionOf(id);
  return addScaled(motion.positionAt(t), X_AXIS, motion.def.radius + altitude);
}

const SITES: readonly Site[] = [
  { name: 'LEO', positionAt: () => v3(R_EARTH + 420e3, 0, 0) },
  { name: '低月周回軌道', positionAt: (t) => aboveSurface('moon', 100e3, t) },
  { name: '地球から 1.5e9 m', positionAt: () => v3(1.5e9, 0, 0) },
  { name: 'ガニメデ近傍', positionAt: (t) => aboveSurface('ganymede', 1000e3, t) },
  // 到達量が km の桁しかない小天体。フレームのあいだに天体自身が到達量の何桁も先へ動く。
  { name: 'ベンヌ近傍', positionAt: (t) => aboveSurface('bennu', 1000, t) },
];

// 天体一式が位置 r へ及ぼす ECI 加速度の和。
function gravitySum(bodies: readonly CelestialBody[], r: Vec3, t: number): Vec3 {
  return bodies.reduce((sum, body) => add(sum, attractorAccel(r, body, t)), v3());
}

// 時刻 t に位置 pos へ効くと絞り込まれた重力源。
function attractorsNear(pos: Vec3, t: number): readonly CelestialBody[] {
  return attractorsNearInto(pos, classifyAttractors(SYSTEM.gravityMotions, t, t, t), []);
}

export function register(): void {
  for (const site of SITES) {
    test(`attractors: ${site.name}で絞り込んだ重力源の重力和は全重力源と GRAVITY_NEGLIGIBLE_ACCEL 以内で一致する`, () => {
      for (const t of SAMPLE_TIMES) {
        const pos = site.positionAt(t);
        const near = attractorsNear(pos, t);
        const diff = len(sub(gravitySum(SYSTEM.gravityMotions, pos, t), gravitySum(near, pos, t)));
        assert.ok(
          diff <= GRAVITY_NEGLIGIBLE_ACCEL,
          `${site.name} t=${t}: 重力和の差 ${diff.toExponential(3)} m/s² (${near.length} 体を採用)`,
        );
        assert.equal(new Set(near).size, near.length, `${site.name} t=${t}: 一覧に同じ天体が重複している`);
      }
    });
  }

  // 分類はフレームに1組だけ組んで全サブステップで使い回すので、**区間内のどの時刻の分類も
  // 覆っていなければならない。** 判定距離へ足す「区間のあいだに動きうる距離」を落とすと、
  // 区間の途中で到達量の内側へ入ってくる天体を取りこぼす。区間は最高段の時間加速で 60 fps の
  // 1フレームが進む時間送り(×33554432 / 60 ≈ 5.6e5 s)。
  test('attractors: フレームに1組だけ組んだ分類は、区間内のどの時刻の分類も覆う', () => {
    const FRAME = 33554432 / 60;
    for (const site of SITES) {
      for (const t0 of SAMPLE_TIMES) {
        const frame = classifyAttractors(SYSTEM.gravityMotions, t0 + FRAME / 2, t0, t0 + FRAME);
        for (let i = 0; i <= 8; i++) {
          const t = t0 + (i / 8) * FRAME;
          const pos = site.positionAt(t);
          const covered = new Set(attractorsNearInto(pos, frame, []));
          for (const body of attractorsNear(pos, t)) {
            assert.ok(covered.has(body), `${site.name} t=${t}: フレームの分類が ${body.id} を落とした`);
          }
        }
      }
    }
  });

  test('attractors: ガニメデ近傍でも月は絞り込みを通る — ECI 原点補正項は問い合わせ位置に依らない', () => {
    for (const t of SAMPLE_TIMES) {
      const ids = attractorsNear(aboveSurface('ganymede', 1000e3, t), t).map((b) => b.id);
      assert.ok(ids.includes('moon'), `t=${t}: 一覧に月が無い: ${ids.join(', ')}`);
    }
  });
}
