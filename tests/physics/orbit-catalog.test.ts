// 焼き込んだ周期軌道カタログの回帰テスト。カタログは JPL の初期条件を種に、その系の質量比で
// 1周期積分して作られる。ここで確かめるのは「焼き込まれた形が本当に CR3BP の周期軌道か」と
// 「実行時 API がそれを回転基底へ正しく載せるか」の2点で、値そのものは JPL 側が正本。
import { orbitingMotionOf, solarSystemParts } from './test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  CATALOG_STRIDE, CatalogFamily, CatalogMember, CatalogSystem, CatalogSystemId, OrbitCatalog,
  decodeCatalogPoints,
} from '../../src/physics/orbit-catalog';
import { catalogLoop, guideSecondary, rotatingFrame } from '../../src/physics/orbit-guide';
import { secondaryFrameOf } from '../../src/physics/lagrange';
import { len, sub } from '../../src/math/vec3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 焼き込みは数MBあり、import で型推論させると tsc が音を上げるので実行時に読む。
// コンパイル後の位置(tests/dist/)から辿るのではなく、リポジトリ根から解決する。
const CATALOG = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/assets/orbits/lagrange-orbits.json'), 'utf8'),
) as OrbitCatalog;

export function register(): void {
  const PARTS = solarSystemParts();
  const t = 1e6;
  const systemIds = Object.keys(CATALOG.systems) as CatalogSystemId[];

  test('orbit-catalog: the bundled catalog carries the two main systems', () => {
    assert.ok(systemIds.includes('earth-moon'), '地球-月系が無い');
    assert.ok(systemIds.includes('sun-earth'), '太陽-地球系が無い');
  });

  for (const systemId of systemIds) {
    const system: CatalogSystem | undefined = CATALOG.systems[systemId];
    if (system === undefined) continue;
    const familyIds = Object.keys(system.families);

    test(`orbit-catalog: ${systemId} families are non-empty and ordered along s`, () => {
      assert.ok(familyIds.length > 0, `${systemId}: 族が1つも無い`);
      for (const id of familyIds) {
        const family: CatalogFamily | undefined = system.families[id];
        assert.ok(family !== undefined, `${id}: 族が無い`);
        assert.ok(family.members.length >= 2, `${id}: メンバーが少なすぎる`);
        const members: readonly CatalogMember[] = family.members;
        assert.equal(members[0]?.s, 0, `${id}: 先頭の s が 0 でない`);
        assert.equal(members[members.length - 1]?.s, 1, `${id}: 末尾の s が 1 でない`);
        for (let i = 1; i < members.length; i++) {
          assert.ok((members[i]?.s ?? 0) > (members[i - 1]?.s ?? 0), `${id}: s が単調でない`);
        }
      }
    });

    test(`orbit-catalog: ${systemId} point arrays match the declared shape`, () => {
      for (const id of familyIds) {
        const family: CatalogFamily = system.families[id]!;
        const values = decodeCatalogPoints(family.points);
        const expected = family.members.length * family.samples * CATALOG_STRIDE;
        assert.equal(values.length, expected, `${id}: 点列の長さが宣言と合わない`);
        assert.ok(values.every((v) => Number.isFinite(v)), `${id}: 有限でない値がある`);
        // 各点の速度。点と点の間はこれを接線とするエルミート補間で埋まるので、
        // 焼き込みで落ちていると曲線が節点の間で潰れる。
        for (let i = 0; i * CATALOG_STRIDE < values.length; i++) {
          const o = i * CATALOG_STRIDE + 4;
          const speed = Math.hypot(values[o] ?? 0, values[o + 1] ?? 0, values[o + 2] ?? 0);
          assert.ok(speed > 0, `${id}: 速度が 0 の点がある (点 ${i})`);
        }
      }
    });

    // 各点に添えた「周期に対する経過時刻」は、弧長等間隔に打った点の上で単調に増える。
    // 進行方向マーカーはこの値で進むので、単調でないとマーカーが戻ってしまう。
    test(`orbit-catalog: ${systemId} time fractions rise monotonically within each orbit`, () => {
      for (const id of familyIds) {
        const family: CatalogFamily = system.families[id]!;
        const values = decodeCatalogPoints(family.points);
        for (let m = 0; m < family.members.length; m++) {
          const base = m * family.samples * CATALOG_STRIDE;
          let previous = -1;
          for (let i = 0; i < family.samples; i++) {
            const tFrac = values[base + i * CATALOG_STRIDE + 3] ?? -1;
            assert.ok(tFrac >= 0 && tFrac < 1, `${id}[${m}]: 時刻割合が範囲外 ${tFrac}`);
            assert.ok(tFrac > previous, `${id}[${m}]: 時刻割合が単調でない`);
            previous = tFrac;
          }
        }
      }
    });

    // 焼き込みは閉じた周期軌道なので、点列の最後の点から先頭へ戻る辺も、他の辺と同じくらいの
    // 長さでなければならない(積分が閉じていなければ、ここだけが飛び抜けて長くなる)。
    test(`orbit-catalog: ${systemId} sampled orbits close back on themselves`, () => {
      for (const id of familyIds) {
        const family: CatalogFamily = system.families[id]!;
        const values = decodeCatalogPoints(family.points);
        for (let m = 0; m < family.members.length; m++) {
          const base = m * family.samples * CATALOG_STRIDE;
          const pointAt = (i: number): [number, number, number] => [
            values[base + i * CATALOG_STRIDE] ?? 0,
            values[base + i * CATALOG_STRIDE + 1] ?? 0,
            values[base + i * CATALOG_STRIDE + 2] ?? 0,
          ];
          const edge = (a: number, b: number): number => {
            const p = pointAt(a);
            const q = pointAt(b);
            return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
          };
          let longest = 0;
          for (let i = 0; i + 1 < family.samples; i++) longest = Math.max(longest, edge(i, i + 1));
          const closing = edge(family.samples - 1, 0);
          // 弧長等間隔に打っているので、閉じる辺も他の辺と同程度に収まる。
          assert.ok(
            closing < 4 * longest,
            `${id}[${m}]: 閉じる辺 ${closing} が他の辺(最長 ${longest})に比べて長すぎる`,
          );
        }
      }
    });

    // 実行時 API が返す点列は、その系の回転基底に載っていなければならない。
    test(`orbit-catalog: ${systemId} runtime loops sit on the rotating frame`, () => {
      const secondary = secondaryFrameOf(
        PARTS.system.celestialBodiesAt(t), orbitingMotionOf(PARTS, guideSecondary(systemId)), t);
      if (secondary === null) return; // レジストリにその系の天体が無い
      const frame = rotatingFrame(secondary, system.mu);
      if (frame === null) return; // レジストリにその系の天体が無い
      for (const id of familyIds.slice(0, 6)) {
        const family: CatalogFamily = system.families[id]!;
        const loop = catalogLoop(secondary, system, id, 0.5);
        assert.ok(loop !== null, `${id}: ガイド線が組めない`);
        assert.ok(loop.shape.kind === 'knots', `${id}: 焼き込み族は節点列で返るはず`);
        const { us, positions, tangents } = loop.shape;
        // 閉じた輪なので、末尾に始点を u=1 として足したぶんが1点多い。
        assert.equal(us.length, family.samples + 1);
        assert.equal(us[0], 0);
        assert.equal(us[us.length - 1], 1);
        for (let i = 0; i < us.length; i++) {
          const p = positions[i]!;
          const m = tangents[i]!;
          assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
          assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.z));
          if (i > 0) assert.ok(us[i]! > us[i - 1]!, `${id}: パラメータが昇順でない`);
          // 軌道の広がりは両天体間距離の数倍を超えない(重心から極端に離れた点が無い)。
          assert.ok(len(sub(p, frame.origin)) < 6 * frame.unit, `${id}: 重心から離れすぎた点がある`);
        }
      }
    });
  }

  test('orbit-guide: every catalog system names a secondary body', () => {
    for (const systemId of systemIds) {
      assert.ok(guideSecondary(systemId).length > 0, `${systemId}: 副天体が無い`);
    }
  });
}
