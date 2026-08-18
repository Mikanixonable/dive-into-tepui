// 外皮の三角形分割。頂点座標と面の索引だけを返し、THREE には一切触れない — 生成した面の
// 面積を loftLateralArea の解析値と突き合わせる検証を、描画器を持たない実行環境で行えるように
// するためである。BufferGeometry への詰め替えは loft-mesh.ts が持つ。
//
// 帯の局所座標は、断面の輪郭を各ノードの断面座標系で受け取り、その基底で船体ローカルへ移す。
// 断面はノードの持ち物であって接続口の持ち物ではないので、基底はノードのものをそのまま使い、
// 原点だけを接続口の中心へ寄せる。

import { Vec3, add, cross, dot, len, norm, scale, sub, v3 } from '../../physics/vec3';
import type { Vec2 } from '../../physics/section-moments';
import { alignOutlines } from '../../physics/hull-loft';

// 断面の座標系から船体ローカル座標系への基底。
export interface HullFrame {
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

// hull エッジ1本ぶんのロフト帯。cap は、その端の断面が他のエッジに覆われず露出しているかどうか。
export interface HullBand {
  readonly outlineA: readonly Vec2[];
  readonly outlineB: readonly Vec2[];
  readonly frameA: HullFrame;
  readonly frameB: HullFrame;
  readonly capA: boolean;
  readonly capB: boolean;
}

// 外皮を持たないエッジの見せ方。lattice は縦通材と等間隔の横枠を持つ骨組み(トラス)、
// collar は縦通材と中央の1枠だけの短い継手(分離機構)。
export type BeamStyle = 'lattice' | 'collar';

export interface HullBeam {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly size: number; // 断面の一辺 [m]
  readonly style: BeamStyle;
}

export interface HullShape {
  readonly bands: readonly HullBand[];
  readonly beams: readonly HullBeam[];
}

export interface HullTriangles {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

// 骨組みの部材の太さを、断面の一辺に対する比で決める。
const BEAM_ROD_RATIO = 0.12;

class Mesh {
  public readonly positions: number[] = [];
  public readonly indices: number[] = [];

  public vertex(p: Vec3): number {
    const index = this.positions.length / 3;
    this.positions.push(p.x, p.y, p.z);
    return index;
  }

  public triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }
}

// 断面座標の点を船体ローカルへ移す。
function toHull(frame: HullFrame, point: Vec2): Vec3 {
  return add(frame.origin, add(scale(frame.x, point.x), scale(frame.y, point.y)));
}

// 進行方向 travel に垂直な共通の基準面。両端の輪郭は各ノードの断面座標系で与えられ、その基底は
// 軸が逆を向くノード同士で鏡像になる。頂点の対応はどちらの断面座標でもなく、この共通面へ落とした
// 位置で取らなければならない — 断面座標のまま比べると、鏡像のぶんだけ帯がねじれる。
interface PlanarBasis {
  readonly e1: Vec3;
  readonly e2: Vec3;
}

function planarBasis(travel: Vec3, hint: Vec3): PlanarBasis {
  const projected = sub(hint, scale(travel, dot(hint, travel)));
  const e1 = norm(len(projected) > 1e-9 ? projected : cross(travel, v3(0, 1, 0)));
  return { e1, e2: cross(travel, e1) };
}

// 世界座標の環を共通面へ落とし、travel まわりに反時計回りになる向きへ揃える。
function orientedRing(ring: readonly Vec3[], basis: PlanarBasis, origin: Vec3): {
  ring: readonly Vec3[];
  planar: readonly Vec2[];
} {
  const planar = ring.map((p) => {
    const d = sub(p, origin);
    return { x: dot(d, basis.e1), y: dot(d, basis.e2) };
  });
  let twice = 0;
  for (let i = 0; i < planar.length; i++) {
    const a = planar[i]!;
    const b = planar[(i + 1) % planar.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  if (twice >= 0) return { ring, planar };
  return { ring: [...ring].reverse(), planar: [...planar].reverse() };
}

function ringCenter(ring: readonly Vec3[]): Vec3 {
  let sum = v3(0, 0, 0);
  for (const point of ring) sum = add(sum, point);
  return scale(sum, 1 / ring.length);
}

function addBand(mesh: Mesh, band: HullBand): void {
  const span = sub(band.frameB.origin, band.frameA.origin);
  if (!(len(span) > 0)) return;
  if (band.outlineA.length !== band.outlineB.length || band.outlineA.length < 3) return;
  const travel = norm(span);
  const basis = planarBasis(travel, band.frameA.x);
  const a = orientedRing(band.outlineA.map((p) => toHull(band.frameA, p)), basis, band.frameA.origin);
  const b = orientedRing(band.outlineB.map((p) => toHull(band.frameB, p)), basis, band.frameB.origin);
  // alignOutlines は入力の頂点そのものを巡回させて返すので、先頭がどこから来たかで巡回量が分かる。
  const aligned = alignOutlines(a.planar, b.planar);
  const shift = b.planar.indexOf(aligned[0]!);
  const count = a.ring.length;
  const ringB = b.ring.map((_, i) => b.ring[(i + shift) % count]!);

  const baseA = a.ring.map((p) => mesh.vertex(p));
  const baseB = ringB.map((p) => mesh.vertex(p));
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    mesh.triangle(baseA[i]!, baseA[j]!, baseB[i]!);
    mesh.triangle(baseA[j]!, baseB[j]!, baseB[i]!);
  }
  if (band.capA) addCap(mesh, a.ring, false);
  if (band.capB) addCap(mesh, ringB, true);
}

// 露出した端面を、重心からの扇で塞ぐ。forward が真なら法線は進行方向、偽なら逆を向く。
function addCap(mesh: Mesh, ring: readonly Vec3[], forward: boolean): void {
  const center = mesh.vertex(ringCenter(ring));
  const rim = ring.map((p) => mesh.vertex(p));
  for (let i = 0; i < rim.length; i++) {
    const j = (i + 1) % rim.length;
    if (forward) mesh.triangle(center, rim[i]!, rim[j]!);
    else mesh.triangle(center, rim[j]!, rim[i]!);
  }
}

// 直方体を1つ足す。ax/ay/az は3方向それぞれの半分の広がりを表すベクトル。
function addBox(mesh: Mesh, center: Vec3, ax: Vec3, ay: Vec3, az: Vec3): void {
  const corners: number[] = [];
  for (const sz of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sx of [-1, 1]) {
        corners.push(mesh.vertex(add(center, add(scale(ax, sx), add(scale(ay, sy), scale(az, sz))))));
      }
    }
  }
  // 索引は (sx, sy, sz) を下位ビットから並べた順。各面を外向きの巻きで張る。
  const faces: readonly (readonly [number, number, number, number])[] = [
    [1, 3, 7, 5], [4, 6, 2, 0], [2, 6, 7, 3], [4, 0, 1, 5], [5, 7, 6, 4], [0, 2, 3, 1],
  ];
  for (const [a, b, c, d] of faces) {
    mesh.triangle(corners[a]!, corners[b]!, corners[c]!);
    mesh.triangle(corners[a]!, corners[c]!, corners[d]!);
  }
}

function addBeam(mesh: Mesh, beam: HullBeam): void {
  const span = sub(beam.b, beam.a);
  const length = len(span);
  if (!(length > 0) || !(beam.size > 0)) return;
  const axis = norm(span);
  const p = norm(cross(Math.abs(axis.y) > 0.9 ? v3(0, 0, 1) : v3(0, 1, 0), axis));
  const q = cross(axis, p);
  const half = beam.size / 2;
  const rod = beam.size * BEAM_ROD_RATIO;
  const center = scale(add(beam.a, beam.b), 0.5);

  // 4隅の縦通材。
  for (const sp of [-1, 1]) {
    for (const sq of [-1, 1]) {
      const offset = add(scale(p, sp * half), scale(q, sq * half));
      addBox(mesh, add(center, offset), scale(axis, length / 2), scale(p, rod / 2), scale(q, rod / 2));
    }
  }

  // 横枠。lattice は断面の一辺ごと、collar は中央に1枠だけ置く。
  const rings = beam.style === 'collar' ? 1 : Math.max(1, Math.round(length / beam.size) - 1);
  for (let i = 0; i < rings; i++) {
    const t = (i + 1) / (rings + 1);
    const at = add(beam.a, scale(axis, length * t));
    for (const [along, across] of [[p, q], [q, p]] as const) {
      for (const side of [-1, 1]) {
        addBox(
          mesh,
          add(at, scale(across, side * half)),
          scale(along, half),
          scale(axis, rod / 2),
          scale(across, rod / 2),
        );
      }
    }
  }
}

export function buildHullTriangles(shape: HullShape): HullTriangles {
  const mesh = new Mesh();
  for (const band of shape.bands) addBand(mesh, band);
  for (const beam of shape.beams) addBeam(mesh, beam);
  return { positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) };
}

// 三角形の面積の総和 [m²]。生成した外皮が解析値どおりの面積を持つかを確かめるために使う。
export function trianglesArea(triangles: HullTriangles): number {
  const { positions, indices } = triangles;
  const at = (i: number): Vec3 => v3(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
  let total = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = at(indices[i]!);
    total += len(cross(sub(at(indices[i + 1]!), a), sub(at(indices[i + 2]!), a))) / 2;
  }
  return total;
}
