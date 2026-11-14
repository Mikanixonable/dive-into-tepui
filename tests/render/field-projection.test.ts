// 方位等距離図法の往復を固定する。uv から戻した単位方向が同じ uv へ写らないと、焼いた texel と
// 読み出しの texel がずれる。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { float, vec2, vec3 } from 'three/tsl';
import { EquidistantCap, OrthographicCap, orthographicCapUv } from '../../src/render/field-projection';
import { capRadiusFor, snapCap } from '../../src/render/cloud/cloud-cap';
import { evaluateShaderNode } from './tsl-node-evaluator';
import { test } from '../harness';

// 円板の内側の uv。中心・中間・縁の近くを取る(四隅は円板の外なので図法の定義域にない)。
const INSIDE_UVS: readonly (readonly [number, number])[] = [
  [0.5, 0.5], [0.65, 0.5], [0.5, 0.8], [0.3, 0.35], [0.5, 0.02], [0.98, 0.5],
];

// 正射影の cap の置き方(中心の緯度経度・円板の半径 [rad])。中緯度・高緯度の広い円板・半球・極の近く。
const ORTHOGRAPHIC_PLACEMENTS: readonly (readonly [number, number, number])[] = [
  [0.6, 2.4, 0.5], [-1.2, -0.7, 1.2], [0, 0, Math.PI / 2], [1.5, 1.0, 0.8],
];
// 焼いた場の 1 辺 [texel]。テストは図法の整合だけを見るので、実機の 512 より粗くてよい。
const BAKE_SIZE = 96;
// 雲場の代わりに焼く、方向だけの滑らかな世界の関数。cap の置き方に依らず同じ値を返す。
function worldField(direction: THREE.Vector3): number {
  return Math.sin(4 * direction.x) + Math.cos(3 * direction.y) + 0.5 * direction.z;
}
// cap の置き方を cap の焼く側の写像(uv → 単位方向)で texel ごとに世界の関数へ焼く。
function bakeWorldField(cap: OrthographicCap): Float64Array {
  const values = new Float64Array(BAKE_SIZE * BAKE_SIZE);
  for (let y = 0; y < BAKE_SIZE; y++) {
    for (let x = 0; x < BAKE_SIZE; x++) {
      const direction = evaluateShaderNode(
        cap.directionAt(vec2((x + 0.5) / BAKE_SIZE, (y + 0.5) / BAKE_SIZE))) as number[];
      values[y * BAKE_SIZE + x] = worldField(new THREE.Vector3(direction[0], direction[1], direction[2]));
    }
  }
  return values;
}
// 焼いた場を、読む側の写像(orthographicCapUv)と、焼き直しのあとの cap の置き方の写し(placement)で
// 単位方向 direction から双線形に読む。CloudFieldSampler が uniform へ写し取るのと同じ値で読む。
function readBakedField(cap: OrthographicCap, values: Float64Array, direction: THREE.Vector3): number {
  const placement = cap.placement;
  const uv = evaluateShaderNode(orthographicCapUv(
    vec3(direction.x, direction.y, direction.z),
    vec3(placement.east.x, placement.east.y, placement.east.z),
    vec3(placement.north.x, placement.north.y, placement.north.z),
    float(placement.sinRadius),
  )) as number[];
  const px = uv[0]! * BAKE_SIZE - 0.5;
  const py = uv[1]! * BAKE_SIZE - 0.5;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  const at = (x: number, y: number): number => values[Math.min(BAKE_SIZE - 1, Math.max(0, y)) * BAKE_SIZE
    + Math.min(BAKE_SIZE - 1, Math.max(0, x))]!;
  return at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy)
    + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
}
// 緯度経度 [rad] の単位方向(CloudPresentation.aim の経度・緯度の取り方と同じ向き)。
function directionOf(latitude: number, longitude: number): THREE.Vector3 {
  return new THREE.Vector3(
    Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude), Math.cos(latitude) * Math.cos(longitude));
}

export function register(): void {
  test('orthographic cap: uv と単位方向は互いの逆写像', () => {
    for (const [latitude, longitude, radius] of ORTHOGRAPHIC_PLACEMENTS) {
      const cap = new OrthographicCap(BAKE_SIZE, latitude, longitude, radius);
      for (const [u, v] of INSIDE_UVS) {
        const direction = evaluateShaderNode(cap.directionAt(vec2(u, v))) as number[];
        assert.ok(Math.abs(Math.hypot(...direction) - 1) < 1e-9, `|direction| ${Math.hypot(...direction)}`);
        const uv = evaluateShaderNode(cap.uvAt(vec3(direction[0]!, direction[1]!, direction[2]!))) as number[];
        assert.ok(Math.abs(uv[0]! - u) < 1e-6, `u ${uv[0]} != ${u} at (${latitude}, ${longitude}, ${radius})`);
        assert.ok(Math.abs(uv[1]! - v) < 1e-6, `v ${uv[1]} != ${v} at (${latitude}, ${longitude}, ${radius})`);
      }
    }
  });

  // 焼いた場を、焼き直した cap の写し(placement)と読む側の写像で読むと、世界の値に一致する。
  // 焼く側と読む側の枠(東・北・半径)が食い違うと、雲は置き直しのたびに cap の中心へ引かれて動く。
  test('orthographic cap: どの置き方でも、焼いた場は同じ方向で世界の値を読み返す', () => {
    for (const [latitude, longitude, radius] of ORTHOGRAPHIC_PLACEMENTS) {
      const cap = new OrthographicCap(BAKE_SIZE, latitude, longitude, radius);
      const values = bakeWorldField(cap);
      for (const [dLatitude, dLongitude] of [[0, 0], [0.1, -0.1], [-0.15, 0.1], [0.2, 0.2], [-0.2, -0.15]] as const) {
        const direction = directionOf(latitude + dLatitude, longitude + dLongitude);
        // 円板の中だけを読む(円板の外は焼いていない)。
        if (direction.dot(directionOf(latitude, longitude)) < Math.cos(radius * 0.85)) continue;
        const read = readBakedField(cap, values, direction);
        assert.ok(Math.abs(read - worldField(direction)) < 5e-3,
          `読み ${read} != 世界 ${worldField(direction)} at (${latitude}, ${longitude}, ${radius}) + (${dLatitude}, ${dLongitude})`);
      }
    }
  });

  // カメラが動いて cap が地表の格子へ置き直されても、固定した 1 点の読みは世界の値のまま動かない。
  test('cloud cap: 視点が動いて cap が置き直されても、同じ地点の雲は動かない', () => {
    const watched = directionOf(0.62, 0.35);
    const rho = 1.08;
    const cap = new OrthographicCap(BAKE_SIZE, 0, 0, 0.1);
    const placements = new Set<string>();
    // 直下点を東へ 3.6 度まで 0.3 度刻みで動かす(cap は格子の刻みごとに置き直される)。
    for (let step = 0; step <= 12; step++) {
      const subpoint = directionOf(0.62, 0.35 + (step * 0.3 * Math.PI) / 180);
      const latitude = Math.asin(subpoint.y);
      const longitude = Math.atan2(subpoint.x, subpoint.z);
      const snapped = snapCap(latitude, longitude, capRadiusFor(rho, 0.0024));
      cap.aim(snapped.latitude, snapped.longitude, snapped.radius);
      placements.add(`${snapped.latitude.toFixed(6)}/${snapped.longitude.toFixed(6)}/${snapped.radius.toFixed(6)}`);
      const read = readBakedField(cap, bakeWorldField(cap), watched);
      assert.ok(Math.abs(read - worldField(watched)) < 5e-3,
        `step ${step}: 読み ${read} != 世界 ${worldField(watched)}`);
    }
    // 置き直しが 1 度も起きない検査では、置き直しの整合を見たことにならない。
    assert.ok(placements.size >= 2, `cap は ${placements.size} 通りの置き方しか取らなかった`);
  });

  test('equidistant cap: uv と単位方向は互いの逆写像', () => {
    const cap = new EquidistantCap(256, 0.3);
    cap.aimAt(new THREE.Vector3(0.3, 0.5, -0.8).normalize(), 0.7);
    for (const [u, v] of INSIDE_UVS) {
      const direction = evaluateShaderNode(cap.directionAt(vec2(u, v))) as number[];
      assert.ok(Math.abs(Math.hypot(...direction) - 1) < 1e-12, `|direction| ${Math.hypot(...direction)}`);
      const uv = evaluateShaderNode(
        cap.uvAt(vec3(direction[0]!, direction[1]!, direction[2]!)),
      ) as number[];
      assert.ok(Math.abs(uv[0]! - u) < 1e-9, `u ${uv[0]} != ${u}`);
      assert.ok(Math.abs(uv[1]! - v) < 1e-9, `v ${uv[1]} != ${v}`);
    }
  });
}
