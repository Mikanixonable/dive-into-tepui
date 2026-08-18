// 2つの断面を軸方向に線形につないだ立体(ロフト)の体積・重心・慣性テンソル・側面積・投影面積を求める
// 純関数群。両端の輪郭を同じ点数でサンプリングして一対一に対応づけると、途中の断面の生モーメントは
// 軸方向位置の4次以下の多項式になり、軸方向の積分が厳密に書ける。輪郭は多角形断面なら断面そのものだが、
// 円・楕円断面では LOFT_SAMPLE_COUNT 点の折れ線で、幾何量はその折れ線に対する厳密値になる。
// 局所座標は、x/y が断面の座標系、z が軸方向で、断面 A が z=0、断面 B が z=length にある。
import {
  CrossSection,
  PlacedSectionPrimitive,
  PolygonMoments,
  Vec2,
  placeSectionPrimitives,
  polygonArea,
  portHalfAngle,
  polygonMomentsAboutOrigin,
} from './section-moments';
import { Vec3, cross, dot, len, norm, sub, v3 } from './vec3';
import type { InertiaTensor } from './inertia-tensor';

export type { InertiaTensor };

// 輪郭のサンプリング点数。3・4・5・6・8 のいずれでも割り切れるため、辺数の異なる断面同士でも
// 頂点が一対一に対応する。
export const LOFT_SAMPLE_COUNT = 120;

// 円弧を折れ線へ置き換えるときの、サンプリング点数に対する細分の倍率。
const CURVE_REFINEMENT = 16;

// 輪郭の連なりを追うときに、2点が同じ位置だとみなす相対許容差。
const JUNCTION_TOLERANCE_RATIO = 1e-6;

// ロフトの端。輪郭を直接渡すと、面積0の輪郭(頂点をすべて1点に潰したもの)で錐の頂点を表せる。
export type LoftEnd = CrossSection | readonly Vec2[];

function isOutline(end: LoftEnd): end is readonly Vec2[] {
  return Array.isArray(end);
}

// ---------------------------------------------------------------------------
// 輪郭の生成
// ---------------------------------------------------------------------------

// 複合断面の外周を sampleCount 点に弧長で等分してサンプリングし、反時計回りに返す。角度ではなく
// 弧長で等分するのは、円に側面の口を設けた断面が円弧と直線の混じった輪郭になるため。
export function sectionOutline(section: CrossSection, sampleCount: number = LOFT_SAMPLE_COUNT): readonly Vec2[] {
  if (!Number.isInteger(sampleCount) || sampleCount < 3) {
    throw new Error(`outline needs at least 3 sample points, got ${sampleCount}`);
  }
  return resampleByArcLength(sectionBoundary(section), sampleCount);
}

// 複合断面の外周を、弧を細かく折った閉じた折れ線として返す。
function sectionBoundary(section: CrossSection): readonly Vec2[] {
  const placed = placeSectionPrimitives(section);
  const root = placed[0]!;
  return root.vertices ? polygonalBoundary(section, placed) : curveBoundary(root);
}

function rotated(point: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: c * point.x - s * point.y, y: s * point.x + c * point.y };
}

// 辺を持たない基本断面(円・楕円)の輪郭。円は側面の口ぶんの弓形を弦で置き換える。
function curveBoundary(root: PlacedSectionPrimitive): readonly Vec2[] {
  const shape = root.shape;
  const phase = root.phaseAngle;
  const refinement = LOFT_SAMPLE_COUNT * CURVE_REFINEMENT;

  if (shape.kind === 'ellipse') {
    const points: Vec2[] = [];
    for (let i = 0; i < refinement; i++) {
      const u = (2 * Math.PI * i) / refinement;
      points.push(rotated({ x: shape.majorRadius * Math.cos(u), y: shape.minorRadius * Math.sin(u) }, phase));
    }
    return points;
  }
  if (shape.kind !== 'circle') throw new Error(`shape "${shape.kind}" has faces and needs a polygonal outline`);

  // 残る円弧だけを並べれば、弓形を切り落とした弦は隣り合う円弧の端点を結ぶ辺として自動的に閉じる。
  const halfAngle = portHalfAngle();
  const points: Vec2[] = [];
  for (let k = 0; k < shape.branchCount; k++) {
    const from = phase + (2 * Math.PI * k) / shape.branchCount + halfAngle;
    const to = phase + (2 * Math.PI * (k + 1)) / shape.branchCount - halfAngle;
    const span = to - from;
    const steps = Math.max(0, Math.ceil((span / (2 * Math.PI)) * refinement));
    for (let i = 0; i <= steps; i++) {
      const angle = steps > 0 ? from + (span * i) / steps : from;
      points.push({ x: shape.radius * Math.cos(angle), y: shape.radius * Math.sin(angle) });
    }
  }
  return points;
}

// 貼り合わせで内側に隠れる辺を、基本断面の id ごとに集める。
function gluedFacesById(section: CrossSection): ReadonlyMap<string, ReadonlySet<number>> {
  const faces = new Map<string, Set<number>>();
  const mark = (id: string, faceIndex: number): void => {
    const set = faces.get(id) ?? new Set<number>();
    set.add(faceIndex);
    faces.set(id, set);
  };
  for (const primitive of section.primitives) {
    const attachment = primitive.attachment;
    if (!attachment) continue;
    mark(attachment.parentId, attachment.parentFaceIndex);
    mark(primitive.id, attachment.childFaceIndex);
  }
  return faces;
}

interface BoundaryEdge {
  readonly from: Vec2;
  readonly to: Vec2;
}

// 多角形だけからなる複合断面の外周。貼り合わせ面は内側に隠れるため、残った辺をつないだ輪になる。
function polygonalBoundary(
  section: CrossSection,
  placed: readonly PlacedSectionPrimitive[],
): readonly Vec2[] {
  const glued = gluedFacesById(section);
  const edges: BoundaryEdge[] = [];
  for (const primitive of placed) {
    const vertices = primitive.vertices;
    if (!vertices) throw new Error(`primitive "${primitive.id}" has no outline of its own`);
    const hidden = glued.get(primitive.id);
    for (let i = 0; i < vertices.length; i++) {
      if (hidden?.has(i)) continue;
      edges.push({ from: vertices[i]!, to: vertices[(i + 1) % vertices.length]! });
    }
  }
  return chainBoundaryEdges(edges);
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// 辺の集合を1つの閉じた輪へ並べ替え、各辺の始点を反時計回りに返す。輪にならない辺の集合には
// 例外を投げる。
function chainBoundaryEdges(edges: readonly BoundaryEdge[]): readonly Vec2[] {
  if (edges.length < 3) throw new Error(`section outline needs at least 3 edges, got ${edges.length}`);
  let extent = 0;
  for (const edge of edges) extent = Math.max(extent, Math.hypot(edge.from.x, edge.from.y));
  const tolerance = extent * JUNCTION_TOLERANCE_RATIO;

  const used = edges.map(() => false);
  used[0] = true;
  const loop: Vec2[] = [edges[0]!.from];
  let current = edges[0]!;
  for (let step = 1; step < edges.length; step++) {
    const nextIndex = findNextBoundaryEdge(edges, used, current, tolerance);
    if (nextIndex < 0) throw new Error('section outline does not close into a single loop');
    used[nextIndex] = true;
    current = edges[nextIndex]!;
    loop.push(current.from);
  }
  if (distance(current.to, edges[0]!.from) > tolerance) {
    throw new Error('section outline does not close into a single loop');
  }
  return loop;
}

// current の終点から続く辺のうち、最も時計回りに折れるものの添字。外周を反時計回りに辿るとき、
// 3つ以上の基本断面が集まる頂点で内側へ入り込まないための選び方。
function findNextBoundaryEdge(
  edges: readonly BoundaryEdge[],
  used: readonly boolean[],
  current: BoundaryEdge,
  tolerance: number,
): number {
  const inX = current.to.x - current.from.x;
  const inY = current.to.y - current.from.y;
  let best = -1;
  let bestTurn = Infinity;
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    const candidate = edges[i]!;
    if (distance(candidate.from, current.to) > tolerance) continue;
    const outX = candidate.to.x - candidate.from.x;
    const outY = candidate.to.y - candidate.from.y;
    const turn = Math.atan2(inX * outY - inY * outX, inX * outX + inY * outY);
    if (turn < bestTurn) {
      bestTurn = turn;
      best = i;
    }
  }
  return best;
}

// 閉じた折れ線を、周長を count 等分した位置でサンプリングし直す。
function resampleByArcLength(closed: readonly Vec2[], count: number): readonly Vec2[] {
  const n = closed.length;
  if (n < 3) throw new Error(`outline needs at least 3 vertices, got ${n}`);
  const cumulative: number[] = [0];
  for (let i = 0; i < n; i++) cumulative.push(cumulative[i]! + distance(closed[i]!, closed[(i + 1) % n]!));
  const total = cumulative[n]!;
  if (!(total > 0)) throw new Error('outline has zero perimeter');

  const points: Vec2[] = [];
  let segment = 0;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / count;
    while (segment < n - 1 && cumulative[segment + 1]! < target) segment++;
    const spanLength = cumulative[segment + 1]! - cumulative[segment]!;
    const fraction = spanLength > 0 ? (target - cumulative[segment]!) / spanLength : 0;
    const a = closed[segment]!;
    const b = closed[(segment + 1) % n]!;
    points.push({ x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction });
  }
  return points;
}

// outline の頂点を巡回させ、reference の同じ添字の頂点との距離の総和が最小になる並びを返す。
// 両端の断面の回転位相が違っても、これで外皮がねじれない対応が選ばれる。
export function alignOutlines(reference: readonly Vec2[], outline: readonly Vec2[]): readonly Vec2[] {
  const n = reference.length;
  if (outline.length !== n) throw new Error(`outlines have ${n} and ${outline.length} points`);
  let bestShift = 0;
  let bestCost = Infinity;
  for (let shift = 0; shift < n; shift++) {
    let cost = 0;
    for (let i = 0; i < n; i++) cost += distance(reference[i]!, outline[(i + shift) % n]!);
    if (cost < bestCost) {
      bestCost = cost;
      bestShift = shift;
    }
  }
  return reference.map((_, i) => outline[(i + bestShift) % n]!);
}

// ---------------------------------------------------------------------------
// 立体の物理量
// ---------------------------------------------------------------------------

// 対応づけ済みの両端の輪郭。
interface LoftOutlines {
  readonly a: readonly Vec2[];
  readonly b: readonly Vec2[];
}

// 両端の輪郭を、同じ添字の頂点が対応するように揃える。端 A の並びを基準とし、端 B だけを巡回させる。
// 点数の違う輪郭同士には例外を投げる。
function loftOutlines(endA: LoftEnd, endB: LoftEnd): LoftOutlines {
  const a = isOutline(endA) ? endA : sectionOutline(endA);
  const b = isOutline(endB) ? endB : sectionOutline(endB);
  if (a.length !== b.length) throw new Error(`loft ends have ${a.length} and ${b.length} outline points`);
  return { a, b: alignOutlines(a, b) };
}

// 軸方向の割合 s における中間断面の輪郭。
function interpolatedOutline(outlines: LoftOutlines, s: number): readonly Vec2[] {
  return outlines.a.map((a, i) => {
    const b = outlines.b[i]!;
    return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
  });
}

// 軸方向の積分に使う5点と、5次まで厳密なブール則の重み。中間断面の輪郭は s の1次なので、その生の
// モーメントは面積が2次、1次モーメントが3次、2次モーメントが4次の多項式になり、被積分関数の次数は
// z を掛ける項(z²·A と z·mx)を含めても4次に収まる。したがってこの重み和は近似ではなく積分そのもの
// である。§10-2 の V=(h/6)(A₁+4Am+A₂) も、2次の面積に対して厳密なシンプソン則という同じ理屈による。
const INTEGRATION_STATIONS = [0, 0.25, 0.5, 0.75, 1];
const INTEGRATION_WEIGHTS = [7 / 90, 32 / 90, 12 / 90, 32 / 90, 7 / 90];

// 密度1の立体の、局所座標原点まわりの体積モーメント。volume は ∫dV、vx は ∫x dV、vxx は ∫x² dV、
// vxy は ∫xy dV を表す。
interface LoftMoments {
  readonly volume: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly vxx: number;
  readonly vyy: number;
  readonly vzz: number;
  readonly vxy: number;
  readonly vxz: number;
  readonly vyz: number;
}

// 対応づけ済みの両端の輪郭が張る立体の、局所座標原点まわりの体積モーメント。
function loftMoments(outlines: LoftOutlines, length: number): LoftMoments {
  // 中間断面の生モーメントを、軸方向の割合 s の積分点ごとに重み付きで足し上げる。
  let volume = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  let vxx = 0;
  let vyy = 0;
  let vzz = 0;
  let vxy = 0;
  let vxz = 0;
  let vyz = 0;
  for (let k = 0; k < INTEGRATION_STATIONS.length; k++) {
    const s = INTEGRATION_STATIONS[k]!;
    const w = INTEGRATION_WEIGHTS[k]!;
    const m: PolygonMoments = polygonMomentsAboutOrigin(interpolatedOutline(outlines, s));
    volume += w * m.area;
    vx += w * m.mx;
    vy += w * m.my;
    vz += w * s * m.area;
    vxx += w * m.mxx;
    vyy += w * m.myy;
    vzz += w * s * s * m.area;
    vxy += w * m.mxy;
    vxz += w * s * m.mx;
    vyz += w * s * m.my;
  }
  // 積分変数を s から z へ戻す。z = s·length かつ dz = length·ds なので、被積分項の s の冪が
  // 1つ増えるごとに length も1つ増える。
  const h2 = length * length;
  return {
    volume: volume * length,
    vx: vx * length,
    vy: vy * length,
    vz: vz * h2,
    vxx: vxx * length,
    vyy: vyy * length,
    vzz: vzz * h2 * length,
    vxy: vxy * length,
    vxz: vxz * h2,
    vyz: vyz * h2,
  };
}

// 体積が0の立体には重心も慣性テンソルも定まらないため、そこで例外を投げる。
function centerOfMassOf(moments: LoftMoments): Vec3 {
  if (!(Math.abs(moments.volume) > 0)) throw new Error('loft volume is zero or not finite');
  return v3(moments.vx / moments.volume, moments.vy / moments.volume, moments.vz / moments.volume);
}

// ロフトの体積 [m³]。
export function loftVolume(sectionA: LoftEnd, sectionB: LoftEnd, length: number): number {
  return loftMoments(loftOutlines(sectionA, sectionB), length).volume;
}

// ロフトの重心。断面 A の座標原点を原点、軸方向を z とする局所座標で表す。
export function loftCenterOfMass(sectionA: LoftEnd, sectionB: LoftEnd, length: number): Vec3 {
  return centerOfMassOf(loftMoments(loftOutlines(sectionA, sectionB), length));
}

// 断面 A から測った重心の軸方向位置 [m]。
export function loftCentroid(sectionA: LoftEnd, sectionB: LoftEnd, length: number): number {
  return loftCenterOfMass(sectionA, sectionB, length).z;
}

// 一様な密度 density [kg/m³] のロフトの、重心まわりの慣性テンソル。
export function loftInertia(
  sectionA: LoftEnd,
  sectionB: LoftEnd,
  length: number,
  density: number,
): InertiaTensor {
  const moments = loftMoments(loftOutlines(sectionA, sectionB), length);
  const center = centerOfMassOf(moments);
  const mass = density * moments.volume;
  const { x: cx, y: cy, z: cz } = center;
  return {
    ixx: density * (moments.vyy + moments.vzz) - mass * (cy * cy + cz * cz),
    iyy: density * (moments.vxx + moments.vzz) - mass * (cx * cx + cz * cz),
    izz: density * (moments.vxx + moments.vyy) - mass * (cx * cx + cy * cy),
    ixy: -density * moments.vxy + mass * cx * cy,
    ixz: -density * moments.vxz + mass * cx * cz,
    iyz: -density * moments.vyz + mass * cy * cz,
  };
}

function at(point: Vec2, z: number): Vec3 {
  return v3(point.x, point.y, z);
}

// 三角形の面積の2倍の大きさを持つ外向き法線ベクトル。
function triangleNormal(p0: Vec3, p1: Vec3, p2: Vec3): Vec3 {
  return cross(sub(p1, p0), sub(p2, p0));
}

// 対応する頂点同士を結んだ側面の帯の面積 [m²]。帯は一般に平面ではないため、四角形を2つの三角形に
// 割って足す。
export function loftLateralArea(sectionA: LoftEnd, sectionB: LoftEnd, length: number): number {
  const outlines = loftOutlines(sectionA, sectionB);
  const n = outlines.a.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a0 = at(outlines.a[i]!, 0);
    const a1 = at(outlines.a[j]!, 0);
    const b0 = at(outlines.b[i]!, length);
    const b1 = at(outlines.b[j]!, length);
    total += (len(triangleNormal(a0, a1, b1)) + len(triangleNormal(a0, b1, b0))) / 2;
  }
  return total;
}

// axis 方向から見たロフトの投影面積 [m²]。閉じた境界面について ∫|n̂·axis| dA の半分を取るので、
// 視線が2回だけ立体を貫く凸な形状では厳密で、凹んだ形状では貫く回数のぶん過大に出る。
export function loftProjectedArea(
  sectionA: LoftEnd,
  sectionB: LoftEnd,
  length: number,
  axis: Vec3,
): number {
  const outlines = loftOutlines(sectionA, sectionB);
  const direction = norm(axis);
  const n = outlines.a.length;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a0 = at(outlines.a[i]!, 0);
    const a1 = at(outlines.a[j]!, 0);
    const b0 = at(outlines.b[i]!, length);
    const b1 = at(outlines.b[j]!, length);
    weighted += Math.abs(dot(triangleNormal(a0, a1, b1), direction));
    weighted += Math.abs(dot(triangleNormal(a0, b1, b0), direction));
  }
  const capArea = Math.abs(polygonArea(outlines.a)) + Math.abs(polygonArea(outlines.b));
  weighted += 2 * Math.abs(direction.z) * capArea;
  return weighted / 4;
}
