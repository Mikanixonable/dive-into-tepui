// 組み立て型の敵(SPEC/ASSEMBLY.md)の部品から描画ジオメトリを組む。中心線を通す管に、
// 開いた端は半球キャップで丸める。部品1個につき1つの BufferGeometry を返す。
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssemblyPartDef } from './assembly-shape';

// 管の周方向の分割数。端の半球キャップも同じ数で組み、継ぎ目の頂点を一致させる。
const RADIAL_SEGMENTS = 10;
// 長手方向の分割数の下限。中心線は形状を追う密度で打たれているので、その点数を下回らない。
const TUBULAR_SEGMENTS_MIN = 24;
// 半球キャップの極方向の分割数。
const CAP_ROWS = 6;

// 部品1個ぶんのジオメトリを返す。破棄は呼び出し側が行う。
export function assemblyPartGeometry(part: AssemblyPartDef): THREE.BufferGeometry {
  const points = part.centerline.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  // 閉じた部品の中心線は終点に始点を重ねてあるので、閉曲線へ入れる前に重複を外す。
  // 端点の一致は浮動小数の桁までしか揃わないので、管半径に対して無視できるずれで判定する。
  if (part.closed && points.length > 1
    && points[points.length - 1]!.distanceToSquared(points[0]!) < 1e-9) {
    points.pop();
  }
  const curve = new THREE.CatmullRomCurve3(points, part.closed);
  const tubularSegments = Math.max(TUBULAR_SEGMENTS_MIN, points.length);
  const tube = new THREE.TubeGeometry(curve, tubularSegments, part.radius, RADIAL_SEGMENTS, part.closed);
  if (part.closed) return tube;
  return mergeGeometries([
    tube,
    capGeometry(tube, 0, points[0]!, curve.getTangentAt(0).negate(), part.radius, true),
    capGeometry(tube, tubularSegments, points[points.length - 1]!, curve.getTangentAt(1), part.radius, false),
  ]);
}

// 管の開放端へ被せる半球キャップ。ringIndex の端リングの頂点から張り出すので継ぎ目に隙間が
// 出ない。axis は管の外側へ向く単位ベクトル。reverse は面の向きの反転 — 終端では端リングの
// 頂点の周り順が外向きと逆なので、始端側だけ立てる。
function capGeometry(
  tube: THREE.BufferGeometry, ringIndex: number, center: THREE.Vector3, axis: THREE.Vector3,
  radius: number, reverse: boolean,
): THREE.BufferGeometry {
  const position = tube.getAttribute('position');
  const ringSize = RADIAL_SEGMENTS + 1;
  const ringStart = ringIndex * ringSize;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // 端リングの各頂点の法線(中心からの単位方向)へ、axis 側へ仰角 e を付けた半球の頂点を張る。
  for (let k = 0; k <= CAP_ROWS; k += 1) {
    const elevation = (k / CAP_ROWS) * (Math.PI / 2);
    const across = Math.cos(elevation);
    const along = Math.sin(elevation);
    for (let j = 0; j <= RADIAL_SEGMENTS; j += 1) {
      const rim = ringStart + j;
      const nx = (position.getX(rim) - center.x) / radius;
      const ny = (position.getY(rim) - center.y) / radius;
      const nz = (position.getZ(rim) - center.z) / radius;
      const dx = nx * across + axis.x * along;
      const dy = ny * across + axis.y * along;
      const dz = nz * across + axis.z * along;
      if (k === 0) {
        positions.push(position.getX(rim), position.getY(rim), position.getZ(rim));
      } else {
        positions.push(center.x + dx * radius, center.y + dy * radius, center.z + dz * radius);
      }
      normals.push(dx, dy, dz);
      uvs.push(j / RADIAL_SEGMENTS, k / CAP_ROWS);
    }
  }
  for (let k = 0; k < CAP_ROWS; k += 1) {
    for (let j = 0; j < RADIAL_SEGMENTS; j += 1) {
      const a = k * ringSize + j;
      const b = a + 1;
      const c = a + ringSize;
      const d = c + 1;
      if (reverse) indices.push(a, b, c, b, d, c);
      else indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}
