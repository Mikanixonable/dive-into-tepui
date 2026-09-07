// triangle-mesh.ts のテスト。BVH は絞り込みの器なので、返る接触は全数探索と一致しなければ
// ならない。三角形1枚だけの BVH を判定器の代わりに使い、全数探索の答えを作って突き合わせる。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  type RayHit, type SphereHit, type Triangle, type TriangleBVH,
  buildBVH, raycastTriangles, sphereCollideTriangles,
} from '../../src/math/triangle-mesh';
import { v3, Vec3, sub, cross, norm } from '../../src/math/vec3';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function triangle(a: Vec3, b: Vec3, c: Vec3): Triangle {
  return { a, b, c, normal: norm(cross(sub(b, a), sub(c, a))) };
}

// 一辺 1 前後の三角形を、一辺 20 の立方体へばらまく。葉の枚数を何段も割る規模にする。
function randomTriangles(rand: () => number, count: number): Triangle[] {
  const triangles: Triangle[] = [];
  for (let i = 0; i < count; i++) {
    const origin = v3((rand() - 0.5) * 20, (rand() - 0.5) * 20, (rand() - 0.5) * 20);
    const corner = (): Vec3 => v3(
      origin.x + (rand() - 0.5), origin.y + (rand() - 0.5), origin.z + (rand() - 0.5),
    );
    triangles.push(triangle(corner(), corner(), corner()));
  }
  return triangles;
}

// 重心が全て同じ値へ潰れる並び。中央値分割が両側を空にしないことを突く。
function coincidentCentroidTriangles(count: number): Triangle[] {
  const triangles: Triangle[] = [];
  for (let i = 0; i < count; i++) {
    const size = 1 + i * 0.01;
    triangles.push(triangle(v3(-size, -size, 0), v3(size, -size, 0), v3(0, size * 2, 0)));
  }
  return triangles;
}

function bruteForceRay(
  singles: readonly (TriangleBVH | null)[], origin: Vec3, dir: Vec3, maxDist: number,
): RayHit | null {
  let closest: RayHit | null = null;
  for (const single of singles) {
    const hit = raycastTriangles(origin, dir, maxDist, single);
    if (hit !== null && hit.distance < (closest?.distance ?? maxDist)) closest = hit;
  }
  return closest;
}

function bruteForceSphere(
  singles: readonly (TriangleBVH | null)[], center: Vec3, radius: number,
): SphereHit | null {
  let deepest: SphereHit | null = null;
  for (const single of singles) {
    const hit = sphereCollideTriangles(center, radius, single);
    if (hit !== null && (deepest === null || hit.depth > deepest.depth)) deepest = hit;
  }
  return deepest;
}

export function register(): void {
  test('triangle-mesh: BVH のレイ判定は全数探索と同じ交差を返す', () => {
    const rand = mulberry32(11);
    const triangles = randomTriangles(rand, 400);
    const bvh = buildBVH(triangles);
    const singles = triangles.map((t) => buildBVH([t]));

    // ばらまいた三角形へ無作為な向きのレイを飛ばしてもほとんど当たらないので、
    // どれか1枚の重心を狙い、当たりと外れが混ざる程度に狙いをずらして撃つ。
    const maxDist = 60;
    for (let i = 0; i < 300; i++) {
      const origin = v3((rand() - 0.5) * 40, (rand() - 0.5) * 40, (rand() - 0.5) * 40);
      const { a, b, c } = triangles[Math.floor(rand() * triangles.length)]!;
      const dir = norm(v3(
        (a.x + b.x + c.x) / 3 - origin.x + (rand() - 0.5),
        (a.y + b.y + c.y) / 3 - origin.y + (rand() - 0.5),
        (a.z + b.z + c.z) / 3 - origin.z + (rand() - 0.5),
      ));
      const expected = bruteForceRay(singles, origin, dir, maxDist);
      const found = raycastTriangles(origin, dir, maxDist, bvh);
      if (expected === null) {
        assert.equal(found, null, `外れるはずのレイ ${i} が当たっている`);
        continue;
      }
      assert.ok(found !== null, `当たるはずのレイ ${i} を BVH が取りこぼした`);
      assert.ok(Math.abs(found!.distance - expected.distance) < 1e-9, `レイ ${i} の距離が違う`);
    }
  });

  test('triangle-mesh: BVH の球判定は全数探索と同じ最深接触を返す', () => {
    const rand = mulberry32(12);
    const triangles = randomTriangles(rand, 400);
    const bvh = buildBVH(triangles);
    const singles = triangles.map((t) => buildBVH([t]));

    for (let i = 0; i < 300; i++) {
      const center = v3((rand() - 0.5) * 24, (rand() - 0.5) * 24, (rand() - 0.5) * 24);
      const radius = 0.2 + rand() * 2;
      const expected = bruteForceSphere(singles, center, radius);
      const found = sphereCollideTriangles(center, radius, bvh);
      if (expected === null) {
        assert.equal(found, null, `触れないはずの球 ${i} が当たっている`);
        continue;
      }
      assert.ok(found !== null, `触れるはずの球 ${i} を BVH が取りこぼした`);
      assert.ok(Math.abs(found!.depth - expected.depth) < 1e-9, `球 ${i} のめり込み深さが違う`);
    }
  });

  test('triangle-mesh: 重心が全て同じ三角形群でも全数探索と一致する', () => {
    const triangles = coincidentCentroidTriangles(200);
    const bvh = buildBVH(triangles);
    const singles = triangles.map((t) => buildBVH([t]));

    const rand = mulberry32(13);
    for (let i = 0; i < 100; i++) {
      const center = v3((rand() - 0.5) * 8, (rand() - 0.5) * 8, (rand() - 0.5) * 2);
      const radius = 0.1 + rand();
      const expected = bruteForceSphere(singles, center, radius);
      const found = sphereCollideTriangles(center, radius, bvh);
      assert.equal(found === null, expected === null, `球 ${i} の当たり判定が全数探索と違う`);
      if (expected !== null) {
        assert.ok(Math.abs(found!.depth - expected.depth) < 1e-9, `球 ${i} のめり込み深さが違う`);
      }
    }
  });

  test('triangle-mesh: 三角形が無ければ BVH は組まれず、判定は当たらない', () => {
    const bvh = buildBVH([]);
    assert.equal(bvh, null);
    assert.equal(raycastTriangles(v3(0, 0, 0), v3(1, 0, 0), 10, bvh), null);
    assert.equal(sphereCollideTriangles(v3(0, 0, 0), 1, bvh), null);
  });
}
