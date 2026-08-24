// ラグランジュ点まわりの周期軌道ガイドの回帰テスト。共線点 γ は文献値が、焼き込んだ族の
// 各メンバーは「CR3BP の周期軌道である」という定義が、それぞれ期待値の正本になる。
// ガイド線そのものは近似なので、値ではなく対称性・連続性・所在という性質で確かめる。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { collinearGamma } from '../../src/physics/lagrange';
import {
  Cr3bpState, cr3bpPropagate, sampleOrbitByArcLength, correctHaloOrbit,
} from '../../src/physics/cr3bp';
import {
  collinearParams, collinearFrame, collinearLocalToBarycentric,
  richardsonAmplitudeX, richardsonCoefficients, richardsonPeriod, richardsonPoint,
} from '../../src/physics/halo';
import {
  GuidePoint, GuideSystem, droLoop, haloGuideLoop, lissajousPath,
  planarLyapunovLoop, verticalLyapunovLoop,
} from '../../src/physics/halo-guide';
import { Ephemeris, EPOCH_T_OFFSET } from '../../src/physics/ephemeris';
import { SOLAR_SYSTEM, MU_EARTH, MU_MOON, MU_SUN } from '../../src/physics/solar-system';
import { Vec3, addScaled, cross, dot, len, norm, sub, v3 } from '../../src/physics/vec3';
import table from '../../src/assets/orbits/lagrange-orbits.json';

const SYSTEMS: GuideSystem[] = ['sun-earth', 'earth-moon'];
const POINTS: GuidePoint[] = ['L1', 'L2', 'L3'];

// 焼き込みと同じ質量比。レジストリの重力定数から組む。
const MU_OF: Record<GuideSystem, number> = {
  'sun-earth': MU_EARTH / (MU_SUN + MU_EARTH),
  'earth-moon': MU_MOON / (MU_EARTH + MU_MOON),
};

interface BakedMember {
  readonly s: number;
  readonly period: number;
  readonly state: readonly number[];
  readonly points: readonly (readonly number[])[];
}

function bakedMembers(system: GuideSystem, point: GuidePoint): readonly BakedMember[] {
  const families = (table.systems as Record<string, { halo: Record<string, { members: BakedMember[] }> }>);
  return families[system]?.halo[point]?.members ?? [];
}

// 焼き込んだ DRO 族の中ほどの軌道半径(両天体間距離を 1 とする無次元量)。
function bakedDroRadius(system: GuideSystem): number {
  const members = (table.systems as Record<string, { dro: { members: { radius: number }[] } }>)[system]?.dro.members ?? [];
  return members[Math.floor(members.length / 2)]?.radius ?? 0;
}

// 点列が1枚の平面に載り、その面が normal を法線に持つことを確かめる。
function assertCoplanar(points: readonly Vec3[], normal: Vec3): void {
  const origin = points[0] as Vec3;
  const planeNormal = norm(cross(sub(points[1] as Vec3, origin), sub(points[points.length / 4 | 0] as Vec3, origin)));
  const scale = Math.max(...points.map((p) => len(sub(p, origin))));
  for (const p of points) {
    assert.ok(Math.abs(dot(sub(p, origin), planeNormal)) < 1e-9 * scale, '同一平面上にない');
  }
  assert.ok(Math.abs(dot(planeNormal, norm(normal))) > 0.99, '面の向きが公転面と揃っていない');
}

function centroid(points: readonly Vec3[]): Vec3 {
  return points.reduce((acc, p) => addScaled(acc, p, 1 / points.length), v3());
}

export function register(): void {
  const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET);
  const t = 1e6;

  // 文献値との突き合わせ。質量比も文献の値を使う(レジストリの質量とは端数が異なる)。
  test('halo-guide: collinearGamma matches the published Earth-Moon values', () => {
    assert.ok(Math.abs(collinearGamma(0.0121505856, 'L1') - 0.150935) < 1e-4);
    assert.ok(Math.abs(collinearGamma(0.0121505856, 'L2') - 0.167833) < 1e-4);
  });

  test('halo-guide: collinearGamma matches the published Sun-Earth value', () => {
    assert.ok(Math.abs(collinearGamma(3.0404e-6, 'L1') - 0.0100109) < 1e-6);
  });

  // L3 の γ は主天体から測る距離比で、5次方程式の根であり、小さい mu では 1-(7/12)mu に漸近する。
  test('halo-guide: collinearGamma solves the L3 quintic', () => {
    for (const mu of [1e-7, 3.0404e-6, 1e-3, 0.0121505856, 0.1]) {
      const g = collinearGamma(mu, 'L3');
      const residual = g ** 5 + (2 + mu) * g ** 4 + (1 + 2 * mu) * g ** 3
        - (1 - mu) * g * g - 2 * (1 - mu) * g - (1 - mu);
      assert.ok(Math.abs(residual) < 1e-12, `mu=${mu}: residual ${residual}`);
      assert.ok(Math.abs(g - (1 - (7 / 12) * mu)) < 20 * mu * mu, `mu=${mu}: gamma ${g}`);
    }
  });

  // Richardson 三次近似は数値解の良い初期推定でなければならない。微分修正が受け取った
  // 種からどれだけ動くかで、近似の質を測る。
  test('halo-guide: the third-order seed is close to the corrected halo orbit', () => {
    for (const system of SYSTEMS) {
      const mu = MU_OF[system];
      for (const point of POINTS) {
        const params = collinearParams(point, mu);
        const c = richardsonCoefficients(params);
        const az = 0.05;
        const ax = richardsonAmplitudeX(c, az);
        const period = richardsonPeriod(c, ax, az);
        const local = richardsonPoint(c, ax, az, true, 0);
        const p0 = collinearLocalToBarycentric(params, local);
        const dtau = 1e-6;
        const p1 = collinearLocalToBarycentric(params, richardsonPoint(c, ax, az, true, dtau));
        const vy = ((p1[1] - p0[1]) / dtau) * (2 * Math.PI / period);
        const seed: Cr3bpState = [p0[0], 0, p0[2], 0, vy, 0];
        const corrected = correctHaloOrbit(mu, seed, 'z', period / 2);
        assert.ok(corrected !== null, `${system}/${point}: 三次近似の種から収束しない`);
        // L3 の γ は両天体間距離とほぼ等しく、L点まわりの局所展開という前提が成り立たない
        // ため、近さは L1/L2 でだけ要求する。
        if (point === 'L3') continue;
        // 軌道の大きさ(γ 単位の振幅を無次元長へ戻したもの)に対する種のずれ。
        const size = Math.hypot(ax, az) * params.gamma;
        const drift = Math.abs(corrected.state[0] - seed[0]) + Math.abs(corrected.state[4] - seed[4]) / (2 * Math.PI / period);
        assert.ok(drift < 0.15 * size, `${system}/${point}: 種のずれ ${drift / size} が大きすぎる`);
        assert.ok(Math.abs(corrected.period - period) < 0.05 * period, `${system}/${point}: 周期のずれ`);
      }
    }
  });

  for (const system of SYSTEMS) {
    const mu = MU_OF[system];
    for (const point of POINTS) {
      const members = bakedMembers(system, point);

      test(`halo-guide: ${system}/${point} baked family covers s in [0,1]`, () => {
        assert.ok(members.length >= 20, `メンバーが少なすぎる: ${members.length}`);
        assert.equal(members[0]?.s, 0);
        assert.equal(members[members.length - 1]?.s, 1);
        for (let i = 1; i < members.length; i++) {
          assert.ok((members[i]?.s ?? 0) > (members[i - 1]?.s ?? 0), 's が単調増加でない');
        }
      });

      // 各メンバーは CR3BP の周期軌道でなければならない。1周期積分して戻ってくるかで確かめる。
      // ハロー軌道は不安定なので、閉合残差は軌道の大きさに対する比で見る。
      test(`halo-guide: ${system}/${point} baked members close after one period`, () => {
        for (const member of members) {
          const [x, z, vy] = member.state as [number, number, number];
          const state: Cr3bpState = [x, 0, z, 0, vy, 0];
          const end = cr3bpPropagate(mu, state, member.period, 40000);
          const size = Math.max(...sampleOrbitByArcLength(mu, state, member.period, 60, 40000)
            .map((p) => Math.hypot(p[0] - x, p[1], p[2] - z)));
          const residual = Math.hypot(end[0] - x, end[1], end[2] - z);
          assert.ok(residual < 0.01 * size, `s=${member.s}: 閉合残差 ${residual / size}`);
        }
      });

      // 族に沿って形は連続に変わる(MAP.md 5.1)。隣接メンバーの点列の隔たりが軌道の
      // 大きさに対して小さいことで確かめる。
      test(`halo-guide: ${system}/${point} baked family changes continuously`, () => {
        const gaps: number[] = [];
        for (let i = 1; i < members.length; i++) {
          const a = members[i - 1]?.points ?? [];
          const b = members[i]?.points ?? [];
          gaps.push(Math.max(...a.map((p, j) => {
            const q = b[j] ?? [];
            return Math.hypot((q[0] ?? 0) - (p[0] ?? 0), (q[1] ?? 0) - (p[1] ?? 0), (q[2] ?? 0) - (p[2] ?? 0));
          })));
        }
        // 族全体の広がりに対して、隣接メンバーの隔たりが小さいこと。
        const familyScale = Math.max(...members.flatMap(
          (m) => m.points.map((p) => Math.hypot(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0)),
        ));
        const worst = Math.max(...gaps);
        assert.ok(worst < 0.4 * familyScale, `形の跳び ${worst / familyScale}`);
      });

      test(`halo-guide: ${system}/${point} guide loop sits around the Lagrange point`, () => {
        const loop = haloGuideLoop(t, ephemeris, system, point, 0.3, 'north', 64);
        assert.ok(loop !== null, 'ガイド線が組めない');
        assert.equal(loop.length, 64);
        const frame = collinearFrame(system === 'sun-earth' ? 'earth' : 'moon', point, t, ephemeris);
        const radius = Math.max(...loop.map((p) => len(sub(p, frame.origin))));
        assert.ok(len(sub(centroid(loop), frame.origin)) < radius, '重心が L点の近傍にない');
      });

      // 北側と南側は公転面法線に沿った鏡像の対。対応する点どうしを結んだ向きが法線と
      // 平行であることで確かめる(法線方向の成分だけが符号を変える)。
      test(`halo-guide: ${system}/${point} north and south loops mirror each other`, () => {
        const north = haloGuideLoop(t, ephemeris, system, point, 0.4, 'north', 48);
        const south = haloGuideLoop(t, ephemeris, system, point, 0.4, 'south', 48);
        assert.ok(north !== null && south !== null);
        const frame = collinearFrame(system === 'sun-earth' ? 'earth' : 'moon', point, t, ephemeris);
        const scale = Math.max(...north.map((p) => len(sub(p, frame.origin))));
        let separated = 0;
        for (let i = 0; i < north.length; i++) {
          const gap = sub(north[i] as Vec3, south[i] as Vec3);
          assert.ok(len(cross(gap, frame.zHat)) < 1e-9 * scale, `法線と平行でない: ${len(cross(gap, frame.zHat)) / scale}`);
          separated = Math.max(separated, len(gap));
        }
        assert.ok(separated > 0.1 * scale, '北側と南側が重なっている');
      });

      test(`halo-guide: ${system}/${point} planar Lyapunov loop lies in the orbital plane`, () => {
        const loop = planarLyapunovLoop(t, ephemeris, system, point, 2e7, 40);
        assert.ok(loop !== null);
        assertCoplanar(loop, collinearFrame(system === 'sun-earth' ? 'earth' : 'moon', point, t, ephemeris).zHat);
      });

      // 垂直リヤプノフ軌道は面外に8の字を描くので、面外振幅と同程度の広がりを持ち、
      // 面外成分が正負の両側へ振れる。
      test(`halo-guide: ${system}/${point} vertical Lyapunov loop is a figure eight`, () => {
        const amplitude = 3e7;
        const loop = verticalLyapunovLoop(t, ephemeris, system, point, amplitude, 64);
        assert.ok(loop !== null);
        const frame = collinearFrame(system === 'sun-earth' ? 'earth' : 'moon', point, t, ephemeris);
        const out = loop.map((p) => dot(sub(p, frame.origin), frame.zHat));
        assert.ok(Math.max(...out) > 0.5 * amplitude && Math.min(...out) < -0.5 * amplitude, '面外に振れていない');
      });

      test(`halo-guide: ${system}/${point} lissajous path is an open polyline`, () => {
        const path = lissajousPath(t, ephemeris, system, point, 1.5e7, 3e7, 3, 90);
        assert.ok(path !== null);
        assert.equal(path.length, 90);
        assert.ok(path.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)));
      });
    }

    // DRO は副天体を囲む面内の閉曲線で、指定半径に見合った大きさを持つ。
    test(`halo-guide: ${system} DRO loop encircles the secondary at the requested radius`, () => {
      const secondaryId = system === 'sun-earth' ? 'earth' : 'moon';
      const frame = collinearFrame(secondaryId, 'L1', t, ephemeris);
      // 焼き込んだ族の内側にある半径を選ぶ(範囲外は端で頭打ちになるため、大きさの比較にならない)。
      const radius = bakedDroRadius(system) * frame.r;
      const loop = droLoop(t, ephemeris, system, radius, 48);
      assert.ok(loop !== null);
      const secondary = ephemeris.positionOf(secondaryId, t);
      const distances = loop.map((p) => len(sub(p, secondary)));
      assert.ok(Math.max(...distances) < 2 * radius, '半径に対して大きすぎる');
      assert.ok(Math.min(...distances) > 0.3 * radius, '副天体を囲んでいない');
      assertCoplanar(loop, frame.zHat);
    });
  }

  // レジストリに副天体が無ければガイド線は組めない。
  test('halo-guide: guides are unavailable in a registry without the secondary', () => {
    const bare = new Ephemeris({ earth: SOLAR_SYSTEM.earth, sun: SOLAR_SYSTEM.sun }, 'earth', EPOCH_T_OFFSET);
    assert.equal(haloGuideLoop(t, bare, 'earth-moon', 'L1', 0.5, 'north', 32), null);
    assert.equal(droLoop(t, bare, 'earth-moon', 1e7, 32), null);
    assert.ok(haloGuideLoop(t, bare, 'sun-earth', 'L1', 0.5, 'north', 32) !== null);
  });
}
