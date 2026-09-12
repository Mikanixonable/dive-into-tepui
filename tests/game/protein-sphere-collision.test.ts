import * as assert from 'node:assert/strict';
import {
  buildProteinCollisionSpheres, ProteinSphereCollisionGeometry,
  type ProteinCollisionSphere,
} from '../../src/game/protein/protein-sphere-collision';
import { v3, type Vec3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { testProteinAssetBundles } from '../protein-test-assets';
import { test } from '../harness';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const ROOT_SCALE = 20;

// 球の中心から点までの距離が半径をどれだけ下回るか [m]。正なら球の内側。
function marginInside(sphere: ProteinCollisionSphere, x: number, y: number, z: number): number {
  return sphere.radius - Math.hypot(x - sphere.cx, y - sphere.cy, z - sphere.cz);
}

// 残基 index の Cα をアセット座標(coordinateScale 込み)で返す。
function residueAt(
  coordinates: readonly number[], index: number, coordinateScale: number,
): Vec3 {
  const offset = index * 3;
  return v3(
    coordinates[offset]! * coordinateScale,
    coordinates[offset + 1]! * coordinateScale,
    coordinates[offset + 2]! * coordinateScale,
  );
}

export function register(): void {
  // 覆い・連続性・大きさは球の組み方そのものの契約なので、全アセットで見る。
  for (const bundle of testProteinAssetBundles()) {
    const id = bundle.semantic.asset.id;
    const { coordinateScale } = bundle.semantic.asset;
    const { backboneCoordinates, backboneCount, backboneChains } = bundle.semantic.backbone;
    const spheres = buildProteinCollisionSpheres(bundle.semantic.backbone, coordinateScale);

    test(`protein sphere collision: ${id} covers every residue`, () => {
      for (let index = 0; index < backboneCount; index++) {
        const residue = residueAt(backboneCoordinates, index, coordinateScale);
        const covered = spheres.some((s) => marginInside(s, residue.x, residue.y, residue.z) >= 0);
        assert.ok(covered, `residue ${index} of ${id} is outside every collision sphere`);
      }
    });

    test(`protein sphere collision: ${id} leaves no gap between residues`, () => {
      // 隣り合う残基を結ぶ線分は、球の凸性から両端が同じ1球に入っていれば丸ごと含まれる。
      for (let index = 1; index < backboneCount; index++) {
        if (backboneChains[index] !== backboneChains[index - 1]) continue;
        const previous = residueAt(backboneCoordinates, index - 1, coordinateScale);
        const current = residueAt(backboneCoordinates, index, coordinateScale);
        const joined = spheres.some((s) => (
          marginInside(s, previous.x, previous.y, previous.z) >= 0
          && marginInside(s, current.x, current.y, current.z) >= 0
        ));
        assert.ok(joined, `the segment ${index - 1}→${index} of ${id} spans two spheres`);
      }
    });

    test(`protein sphere collision: ${id} keeps the outer radius near the drawn size`, () => {
      let drawnRadius = 0;
      for (let index = 0; index < backboneCount; index++) {
        const residue = residueAt(backboneCoordinates, index, coordinateScale);
        drawnRadius = Math.max(drawnRadius, Math.hypot(residue.x, residue.y, residue.z));
      }
      const geometry = new ProteinSphereCollisionGeometry(spheres, ROOT_SCALE);
      const ratio = geometry.outerRadius / (drawnRadius * ROOT_SCALE);
      assert.ok(ratio >= 1 && ratio <= 1.3, `${id} outer radius is ${ratio.toFixed(2)}x the drawn size`);
    });
  }

  test('protein sphere collision: the sweep agrees with the resting test at its own toi', () => {
    const geometry = new ProteinSphereCollisionGeometry(
      [{ cx: 0, cy: 0, cz: 0, radius: 1 }], ROOT_SCALE,
    );
    const center = v3();
    const previous = kinematicState<'eci'>(0, center, v3());
    const current = kinematicState<'eci'>(1, center, v3());
    const bulletRadius = 2;

    const swept = geometry.testSweptSphereCollision(
      v3(0, 0, 100), v3(0, 0, -100), bulletRadius, previous, current, IDENTITY,
    );
    assert.ok(swept, 'a sphere crossing the collision sphere between frames should hit');
    assert.ok(swept!.toi > 0 && swept!.toi < 1, 'the swept hit should report an interior toi');

    // TOI では表面がちょうど接するので、そこから僅かに進めた位置では静止判定も当たる。
    const past = v3(0, 0, 100 - 200 * (swept!.toi + 1e-6));
    assert.ok(
      geometry.testSphereCollision(past, bulletRadius, center, IDENTITY),
      'the resting test should hit just past the reported toi',
    );

    const missed = geometry.testSweptSphereCollision(
      v3(100, 0, 100), v3(100, 0, -100), bulletRadius, previous, current, IDENTITY,
    );
    assert.equal(missed, null, 'a sphere passing outside the collision sphere should miss');
  });
}
