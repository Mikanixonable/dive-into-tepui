// 焼いた基地の判定形状 (src/assets/models/baseCollision.json) を表示モデルへ突き合わせる。
// 判定形状は部品ごとの凸包なので、覆いは構成から成り立つ — 崩れるとしたら部品の切り分けか、
// 表示モデルを変えたのに焼き直していないかのどちらかで、どちらも黙って当たり方を変える。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { BASE_COLLISION_RADIUS, baseRaycast } from '../../src/game/dynamic/dynamic-entity/base-collision';
import { buildBaseModel } from '../../src/render/base-station-model';
import { Triangle, buildBVH, raycastTriangles } from '../../src/math/triangle-mesh';
import { mulberry32 } from '../../src/math/random';
import { Vec3, v3, add, cross, dot, lenSq, norm, scale, sub } from '../../src/math/vec3';
import { test } from '../harness';
import bakedShape from '../../src/assets/models/baseCollision.json';

// 焼いた座標の刻み (tools/export-base-collision.mjs の COORDINATE_SCALE)。
const BAKED_COORDINATE_SCALE = 1e3;
// 焼いた座標は mm 単位まで丸めてあるので、凸包の面が元の頂点より最大 √3/2 mm だけ内側へ寄る。
// 覆いとめり込みの判定はその丸めより緩く取る。
const ROUNDING_MARGIN = 0.01;
// 表示モデルの頂点が判定形状の内側にあると認める許容 [m]。
const COVER_TOLERANCE = 0.5;

// 判定面が見えている面より手前に出てよい距離 [m]。自艦の接触半径 2.6 m の数倍までとする。
const FLOAT_MEDIAN_LIMIT = 5;
const FLOAT_P90_LIMIT = 20;

// 浮きを測るレイ。外接半径の外から、表示モデルの外接箱の中の点へ向けて撃つ。
const RAY_COUNT = 6000;
const RAY_ORIGIN_RADIUS = 1200;

// 凸包の面が張る半空間。内側なら dot(normal, p) <= offset。
interface Plane {
  readonly normal: Vec3;
  readonly offset: number;
}

// 焼いた三角形を、頂点を共有するものどうしで部品(凸包)へ戻したもの。
interface CollisionHull {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly planes: readonly Plane[];
}

interface DisplayModel {
  readonly triangles: readonly Triangle[];
  readonly vertices: readonly Vec3[];
  readonly min: Vec3;
  readonly max: Vec3;
  readonly outerRadius: number;
}

const shape = bakedShape as unknown as { readonly positions: number[]; readonly indices: number[] };

function bakedVertex(index: number): Vec3 {
  return v3(shape.positions[index * 3], shape.positions[index * 3 + 1], shape.positions[index * 3 + 2]);
}

// 三角形を、頂点の添字を共有するものどうしでまとめる (union-find)。凸包は閉じた面なので、
// 添字を共有しない三角形は別の部品に属する。
function hullTriangleGroups(): number[][] {
  const triangleCount = shape.indices.length / 3;
  const parent = Array.from({ length: triangleCount }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const ownerOfVertex = new Map<number, number>();
  for (let i = 0; i < shape.indices.length; i++) {
    const triangle = Math.floor(i / 3);
    const known = ownerOfVertex.get(shape.indices[i]);
    if (known === undefined) {
      ownerOfVertex.set(shape.indices[i], triangle);
      continue;
    }
    const a = find(known);
    const b = find(triangle);
    if (a !== b) parent[a] = b;
  }

  const groups = new Map<number, number[]>();
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const root = find(triangle);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [triangle]);
    else group.push(triangle);
  }
  return [...groups.values()];
}

function collisionHulls(): CollisionHull[] {
  return hullTriangleGroups().map((triangles) => {
    const planes: Plane[] = [];
    let min = v3(Infinity, Infinity, Infinity);
    let max = v3(-Infinity, -Infinity, -Infinity);
    for (const triangle of triangles) {
      const a = bakedVertex(shape.indices[triangle * 3]);
      const b = bakedVertex(shape.indices[triangle * 3 + 1]);
      const c = bakedVertex(shape.indices[triangle * 3 + 2]);
      for (const p of [a, b, c]) {
        min = v3(Math.min(min.x, p.x), Math.min(min.y, p.y), Math.min(min.z, p.z));
        max = v3(Math.max(max.x, p.x), Math.max(max.y, p.y), Math.max(max.z, p.z));
      }
      const normal = norm(cross(sub(b, a), sub(c, a)));
      planes.push({ normal, offset: dot(normal, a) });
    }
    return { min, max, planes };
  });
}

function insideHull(hull: CollisionHull, p: Vec3, tolerance: number): boolean {
  if (p.x < hull.min.x - tolerance || p.x > hull.max.x + tolerance) return false;
  if (p.y < hull.min.y - tolerance || p.y > hull.max.y + tolerance) return false;
  if (p.z < hull.min.z - tolerance || p.z > hull.max.z + tolerance) return false;
  for (const plane of hull.planes) {
    if (dot(plane.normal, p) > plane.offset + tolerance) return false;
  }
  return true;
}

function buildDisplayModel(): DisplayModel {
  const root = buildBaseModel();
  root.updateMatrixWorld(true);

  const triangles: Triangle[] = [];
  const vertices: Vec3[] = [];
  const seen = new Set<string>();
  let min = v3(Infinity, Infinity, Infinity);
  let max = v3(-Infinity, -Infinity, -Infinity);
  let outerRadiusSquared = 0;
  const world = new THREE.Vector3();

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    const geometry = mesh.geometry.index === null ? mesh.geometry : mesh.geometry.toNonIndexed();
    const position = geometry.attributes.position;
    if (position === undefined) return;

    const corners: Vec3[] = [];
    for (let i = 0; i < position.count; i++) {
      world.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      const p = v3(world.x, world.y, world.z);
      corners.push(p);
      min = v3(Math.min(min.x, p.x), Math.min(min.y, p.y), Math.min(min.z, p.z));
      max = v3(Math.max(max.x, p.x), Math.max(max.y, p.y), Math.max(max.z, p.z));
      outerRadiusSquared = Math.max(outerRadiusSquared, lenSq(p));
      const key = `${p.x},${p.y},${p.z}`;
      if (!seen.has(key)) {
        seen.add(key);
        vertices.push(p);
      }
    }
    for (let i = 0; i + 2 < corners.length; i += 3) {
      const a = corners[i];
      const b = corners[i + 1];
      const c = corners[i + 2];
      const normal = norm(cross(sub(b, a), sub(c, a)));
      if (lenSq(normal) > 1e-6) triangles.push({ a, b, c, normal });
    }
  });

  return { triangles, vertices, min, max, outerRadius: Math.sqrt(outerRadiusSquared) };
}

// 表示モデルの組み立ては 3 ケースで使い回す。
let displayModel: DisplayModel | null = null;
function display(): DisplayModel {
  if (displayModel === null) displayModel = buildDisplayModel();
  return displayModel;
}

export function register(): void {
  test('base collision: the baked shape covers every vertex of the display model', () => {
    const { vertices } = display();
    const hulls = collisionHulls();
    const uncovered = vertices.filter(
      (p) => !hulls.some((hull) => insideHull(hull, p, COVER_TOLERANCE)),
    );
    assert.equal(
      uncovered.length, 0,
      `${uncovered.length}/${vertices.length} display vertices fall outside the baked hulls`
      + ` (first at ${JSON.stringify(uncovered[0])})`,
    );
  });

  test('base collision: the baked shape does not float in front of the visible surface', () => {
    const { triangles, min, max } = display();
    const modelBVH = buildBVH(triangles);
    const random = mulberry32(20260906);
    const maxDist = 4 * RAY_ORIGIN_RADIUS;

    const floats: number[] = [];
    for (let i = 0; i < RAY_COUNT; i++) {
      const z = 2 * random() - 1;
      const azimuth = 2 * Math.PI * random();
      const ring = Math.sqrt(1 - z * z);
      const origin = scale(
        v3(ring * Math.cos(azimuth), ring * Math.sin(azimuth), z), RAY_ORIGIN_RADIUS,
      );
      const target = add(min, v3(
        (max.x - min.x) * random(), (max.y - min.y) * random(), (max.z - min.z) * random(),
      ));
      const dir = norm(sub(target, origin));

      const modelHit = raycastTriangles(origin, dir, maxDist, modelBVH);
      if (modelHit === null) continue;
      const collisionHit = baseRaycast(origin, dir, maxDist);
      if (collisionHit === null) continue;
      floats.push(modelHit.distance - collisionHit.distance);
    }

    assert.ok(floats.length > RAY_COUNT / 10, `only ${floats.length} rays hit both shapes`);
    floats.sort((a, b) => a - b);
    const median = floats[Math.floor(floats.length / 2)];
    const p90 = floats[Math.floor(floats.length * 0.9)];
    assert.ok(
      floats[0] >= -ROUNDING_MARGIN,
      `the baked shape sinks ${-floats[0]} m into the visible surface`,
    );
    assert.ok(median <= FLOAT_MEDIAN_LIMIT, `median float ${median} m exceeds ${FLOAT_MEDIAN_LIMIT} m`);
    assert.ok(p90 <= FLOAT_P90_LIMIT, `90th percentile float ${p90} m exceeds ${FLOAT_P90_LIMIT} m`);
  });

  // 凸包の頂点は必ず元の頂点そのものなので、表示モデルを変えて焼き直しを忘れると、
  // 焼いた頂点がモデルのどこにも無くなる。覆い (テスト1) が見ない「モデルが縮んだ」向きの砦。
  test('base collision: every baked vertex is still a vertex of the display model', () => {
    const key = (p: Vec3): string => [p.x, p.y, p.z]
      .map((c) => Math.round(c * BAKED_COORDINATE_SCALE)).join(',');
    const modelKeys = new Set(display().vertices.map(key));
    const stale: Vec3[] = [];
    for (let i = 0; i * 3 < shape.positions.length; i++) {
      const p = bakedVertex(i);
      if (!modelKeys.has(key(p))) stale.push(p);
    }
    assert.equal(
      stale.length, 0,
      `${stale.length} baked vertices are absent from the display model`
      + ` (first at ${JSON.stringify(stale[0])}); re-run npm run base-collision`,
    );
  });

  test('base collision: the outer radius reaches the farthest vertex of the display model', () => {
    const { outerRadius } = display();
    assert.ok(
      BASE_COLLISION_RADIUS >= outerRadius - ROUNDING_MARGIN,
      `BASE_COLLISION_RADIUS ${BASE_COLLISION_RADIUS} m is inside the model radius ${outerRadius} m`,
    );
  });
}
