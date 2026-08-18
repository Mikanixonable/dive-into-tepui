// 断面(基本断面を面で貼り合わせた複合体)の面積・重心・断面二次モーメントを、数値積分を使わず
// すべて閉形式で求める純関数群。基本断面同士が重ならない断面に限り、複合体の幾何量は構成要素の
// 総和として厳密に書ける — 重なる断面は総和が成り立たないため例外になる。THREE/DOM 非依存。

// 断面平面上の点 [m]。
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

// 断面二次モーメント [m⁴]。ix は x 軸まわり(∫y²dA)、iy は y 軸まわり(∫x²dA)、
// ixy は相乗モーメント(∫xy dA)。
export interface SecondMoments {
  readonly ix: number;
  readonly iy: number;
  readonly ixy: number;
}

export type PrimitiveShape =
  | { kind: 'circle'; radius: number; branchCount: 2 | 3 | 4 | 5 | 6 }
  | { kind: 'ellipse'; majorRadius: number; minorRadius: number }
  | { kind: 'polygon'; sides: 3 | 4 | 5 | 6 | 8; radius: number }
  | { kind: 'notched'; sides: 6 | 8; radius: number };

// 親の1つの辺に、自分の1つの辺を重ねて貼り付ける指定。2つの辺の長さは等しくなければならない。
export interface PrimitiveAttachment {
  readonly parentId: string;
  readonly parentFaceIndex: number;
  readonly childFaceIndex: number;
}

export interface SectionPrimitive {
  readonly id: string;
  readonly shape: PrimitiveShape;
  readonly phaseAngle: number; // この基本断面の回転位相 [rad]
  readonly attachment: PrimitiveAttachment | null; // null は複合体の根
}

export interface CrossSection {
  readonly primitives: readonly SectionPrimitive[];
}

// 複合断面全体の幾何量。ix/iy/ixy は重心まわり、centroid は断面の座標系で表した重心。
export interface SectionMoments {
  readonly area: number;
  readonly centroid: Vec2;
  readonly ix: number;
  readonly iy: number;
  readonly ixy: number;
}

// 弓形の幾何量。centroidDist は円の中心から弓形の重心までの距離、ix/iy は円の中心まわりで、
// 弓形が +x 方向を向いている姿勢での値。
export interface CircleSegmentMoments {
  readonly area: number;
  readonly centroidDist: number;
  readonly ix: number;
  readonly iy: number;
}

// 側面の口の軸方向寸法と、円断面が切り落とす弦の長さを、母断面の外接円半径に対する比で与える。
// 1.0 は分岐数6の口どうしがちょうど接する上限であり、これを超えると弓形が重なる。
export const PORT_WIDTH_RATIO = 1.0;

// 貼り合わせる2辺の長さが等しいとみなす相対許容差。
const FACE_LENGTH_TOLERANCE = 1e-9;

// 座標原点まわりの生のモーメント。面積の足し引きがそのまま各項の加減算になるので、複合断面の合成と
// 弓形の差し引きを同じ形で書ける。重心まわりへ移す前の値なので、面積0の図形に対しても定義される。
export interface PolygonMoments {
  readonly area: number;
  readonly mx: number; // ∫x dA
  readonly my: number; // ∫y dA
  readonly mxx: number; // ∫x² dA
  readonly myy: number; // ∫y² dA
  readonly mxy: number; // ∫xy dA
}

const ZERO_MOMENTS: PolygonMoments = { area: 0, mx: 0, my: 0, mxx: 0, myy: 0, mxy: 0 };

function addMoments(a: PolygonMoments, b: PolygonMoments): PolygonMoments {
  return {
    area: a.area + b.area,
    mx: a.mx + b.mx,
    my: a.my + b.my,
    mxx: a.mxx + b.mxx,
    myy: a.myy + b.myy,
    mxy: a.mxy + b.mxy,
  };
}

function subtractMoments(a: PolygonMoments, b: PolygonMoments): PolygonMoments {
  return {
    area: a.area - b.area,
    mx: a.mx - b.mx,
    my: a.my - b.my,
    mxx: a.mxx - b.mxx,
    myy: a.myy - b.myy,
    mxy: a.mxy - b.mxy,
  };
}

// 図形を原点まわりに angle だけ回した後のモーメント。
function rotateMoments(m: PolygonMoments, angle: number): PolygonMoments {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    area: m.area,
    mx: c * m.mx - s * m.my,
    my: s * m.mx + c * m.my,
    mxx: c * c * m.mxx - 2 * s * c * m.mxy + s * s * m.myy,
    myy: s * s * m.mxx + 2 * s * c * m.mxy + c * c * m.myy,
    mxy: s * c * m.mxx + (c * c - s * s) * m.mxy - s * c * m.myy,
  };
}

// 単純多角形の、座標原点まわりの生のモーメント。頂点は反時計回りに与える。頂点が3つ未満の頂点列には
// 例外を投げるが、全頂点が一致した面積0の頂点列は零モーメントとして扱う。
export function polygonMomentsAboutOrigin(vertices: readonly Vec2[]): PolygonMoments {
  if (vertices.length < 3) throw new Error(`polygon needs at least 3 vertices, got ${vertices.length}`);
  let area = 0;
  let mx = 0;
  let my = 0;
  let mxx = 0;
  let myy = 0;
  let mxy = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    mx += (a.x + b.x) * cross;
    my += (a.y + b.y) * cross;
    mxx += (a.x * a.x + a.x * b.x + b.x * b.x) * cross;
    myy += (a.y * a.y + a.y * b.y + b.y * b.y) * cross;
    mxy += (a.x * b.y + 2 * a.x * a.y + 2 * b.x * b.y + b.x * a.y) * cross;
  }
  return { area: area / 2, mx: mx / 6, my: my / 6, mxx: mxx / 12, myy: myy / 12, mxy: mxy / 24 };
}

// 原点まわりのモーメントを重心まわりへ平行軸の定理で移す。
function toCentroidal(m: PolygonMoments): SectionMoments {
  if (!(Math.abs(m.area) > 0)) throw new Error('section area is zero or not finite');
  const cx = m.mx / m.area;
  const cy = m.my / m.area;
  return {
    area: m.area,
    centroid: { x: cx, y: cy },
    ix: m.myy - m.area * cy * cy,
    iy: m.mxx - m.area * cx * cx,
    ixy: m.mxy - m.area * cx * cy,
  };
}

// 単純多角形の面積 [m²]。頂点を反時計回りに与えると正になる。
export function polygonArea(vertices: readonly Vec2[]): number {
  return polygonMomentsAboutOrigin(vertices).area;
}

// 単純多角形の重心。面積が0の退化した頂点列に対しては例外を投げる。
export function polygonCentroid(vertices: readonly Vec2[]): Vec2 {
  return toCentroidal(polygonMomentsAboutOrigin(vertices)).centroid;
}

// 単純多角形の重心まわりの断面二次モーメント。
export function polygonSecondMoments(vertices: readonly Vec2[]): SecondMoments {
  const c = toCentroidal(polygonMomentsAboutOrigin(vertices));
  return { ix: c.ix, iy: c.iy, ixy: c.ixy };
}

// 単純多角形の、座標原点を通る軸まわりの断面二次モーメント。
export function polygonSecondMomentsAboutOrigin(vertices: readonly Vec2[]): SecondMoments {
  const m = polygonMomentsAboutOrigin(vertices);
  return { ix: m.myy, iy: m.mxx, ixy: m.mxy };
}

// 正 sides 角形の頂点を反時計回りに返す。radius は外接円半径で、頂点0は phaseAngle の方向にある。
export function regularPolygonVertices(sides: number, radius: number, phaseAngle: number): readonly Vec2[] {
  if (sides < 3) throw new Error(`regular polygon needs at least 3 sides, got ${sides}`);
  const vertices: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = phaseAngle + (2 * Math.PI * i) / sides;
    vertices.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  }
  return vertices;
}

// 切り欠き型多角形の頂点を反時計回りに返す。長い辺と短い辺が 1:2 の比で交互に並ぶ形で、
// 六角形は正三角形の、八角形は正方形の角を切り落としたものにあたる。radius は外接円半径。
export function notchedPolygonVertices(sides: 6 | 8, radius: number, phaseAngle: number): readonly Vec2[] {
  const baseSides = sides / 2;
  const interiorAngle = (Math.PI * (baseSides - 2)) / baseSides;
  // 角を各辺に沿って 1 だけ切り落とすと、切り口の辺は 2·sin(内角/2) になる。長辺が短辺の2倍に
  // なる元の辺長はこれで一意に決まる。
  const cutEdge = 2 * Math.sin(interiorAngle / 2);
  const baseEdge = 2 + 2 * cutEdge;
  const baseRadius = baseEdge / (2 * Math.sin(Math.PI / baseSides));
  const base = regularPolygonVertices(baseSides, baseRadius, phaseAngle);

  const unscaled: Vec2[] = [];
  for (let i = 0; i < baseSides; i++) {
    const prev = base[(i + baseSides - 1) % baseSides]!;
    const next = base[(i + 1) % baseSides]!;
    const vertex = base[i]!;
    unscaled.push(pointToward(vertex, prev, 1));
    unscaled.push(pointToward(vertex, next, 1));
  }
  const first = unscaled[0]!;
  const scale = radius / Math.hypot(first.x, first.y);
  return unscaled.map((v) => ({ x: v.x * scale, y: v.y * scale }));
}

// from から to の方向へ distance だけ進んだ点。
function pointToward(from: Vec2, to: Vec2, distance: number): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  return { x: from.x + (dx / length) * distance, y: from.y + (dy / length) * distance };
}

// 半径 radius の円から中心角 2·halfAngle の弓形を切り落とすときの、その弓形の幾何量。
export function circleSegmentMoments(radius: number, halfAngle: number): CircleSegmentMoments {
  const s = Math.sin(halfAngle);
  const c = Math.cos(halfAngle);
  const r2 = radius * radius;
  const r4 = r2 * r2;
  const area = r2 * (halfAngle - s * c);
  return {
    area,
    centroidDist: area > 0 ? (2 * radius * s * s * s) / (3 * (halfAngle - s * c)) : radius,
    ix: (r4 / 4) * (halfAngle - s * c - (2 / 3) * s * s * s * c),
    iy: (r4 / 4) * (halfAngle + s * c - 2 * s * c * c * c),
  };
}

// 側面の口が切り落とす弓形の半中心角 [rad]。弦の長さが母断面の半径 × PORT_WIDTH_RATIO になる角。
export function portHalfAngle(): number {
  return Math.asin(PORT_WIDTH_RATIO / 2);
}

// 側面の口ぶんの弓形を差し引いた円断面の、原点まわりのモーメント。
function circleMoments(radius: number, branchCount: number, phaseAngle: number): PolygonMoments {
  const disc = Math.PI * radius * radius;
  const discSecond = (Math.PI * radius ** 4) / 4;
  let moments: PolygonMoments = { area: disc, mx: 0, my: 0, mxx: discSecond, myy: discSecond, mxy: 0 };
  const segment = circleSegmentMoments(radius, portHalfAngle());
  const alongX: PolygonMoments = {
    area: segment.area,
    mx: segment.area * segment.centroidDist,
    my: 0,
    mxx: segment.iy,
    myy: segment.ix,
    mxy: 0,
  };
  for (let i = 0; i < branchCount; i++) {
    const direction = phaseAngle + (2 * Math.PI * i) / branchCount;
    moments = subtractMoments(moments, rotateMoments(alongX, direction));
  }
  return moments;
}

// 楕円断面の原点まわりのモーメント。長半径は phaseAngle の方向を向く。
function ellipseMoments(majorRadius: number, minorRadius: number, phaseAngle: number): PolygonMoments {
  const a = majorRadius;
  const b = minorRadius;
  const unrotated: PolygonMoments = {
    area: Math.PI * a * b,
    mx: 0,
    my: 0,
    mxx: (Math.PI * a * a * a * b) / 4,
    myy: (Math.PI * a * b * b * b) / 4,
    mxy: 0,
  };
  return rotateMoments(unrotated, phaseAngle);
}

// 辺を持つ基本断面。
type PolygonalShape = Extract<PrimitiveShape, { kind: 'polygon' | 'notched' }>;

function isPolygonal(shape: PrimitiveShape): shape is PolygonalShape {
  return shape.kind === 'polygon' || shape.kind === 'notched';
}

// 辺を持つ基本断面の輪郭を反時計回りに返す。
function polygonalVertices(shape: PolygonalShape, phaseAngle: number): readonly Vec2[] {
  return shape.kind === 'polygon'
    ? regularPolygonVertices(shape.sides, shape.radius, phaseAngle)
    : notchedPolygonVertices(shape.sides, shape.radius, phaseAngle);
}

// 複合体の中に配置し終えた基本断面。vertices が null のとき(円と楕円)は shape と phaseAngle が
// 断面の座標系での姿勢を表し、それ以外では vertices が配置後の輪郭を持つ。
export interface PlacedSectionPrimitive {
  readonly id: string;
  readonly shape: PrimitiveShape;
  readonly phaseAngle: number;
  readonly vertices: readonly Vec2[] | null;
}

interface PlacedPrimitive extends PlacedSectionPrimitive {
  readonly moments: PolygonMoments;
}

// 複合体の根を、自身の回転位相のまま断面の座標原点へ置く。辺を持つ基本断面だけが配置後の輪郭を持つ。
function placeRoot(primitive: SectionPrimitive): PlacedPrimitive {
  const shape = primitive.shape;
  const phase = primitive.phaseAngle;
  const identity = { id: primitive.id, shape, phaseAngle: phase };
  if (shape.kind === 'circle') {
    return { ...identity, vertices: null, moments: circleMoments(shape.radius, shape.branchCount, phase) };
  }
  if (!isPolygonal(shape)) {
    return { ...identity, vertices: null, moments: ellipseMoments(shape.majorRadius, shape.minorRadius, phase) };
  }
  const vertices = polygonalVertices(shape, phase);
  return { ...identity, vertices, moments: polygonMomentsAboutOrigin(vertices) };
}

// 親の辺に子の辺を重ねて子を配置する。2辺は向きが逆になるように重なるので、子は親の外側に出る。
// 子自身の回転位相は、この拘束に吸収されて結果に現れない。
function placeChild(
  primitive: SectionPrimitive,
  attachment: PrimitiveAttachment,
  parent: PlacedPrimitive,
): PlacedPrimitive {
  const parentVertices = parent.vertices;
  if (!parentVertices) throw new Error(`primitive "${parent.id}" has no face to attach "${primitive.id}" to`);
  if (!isPolygonal(primitive.shape)) {
    throw new Error(`primitive "${primitive.id}" has no face and can only be the root`);
  }
  const localVertices = polygonalVertices(primitive.shape, primitive.phaseAngle);

  const parentFace = faceOf(parentVertices, attachment.parentFaceIndex, parent.id);
  const childFace = faceOf(localVertices, attachment.childFaceIndex, primitive.id);
  const parentLength = Math.hypot(parentFace.to.x - parentFace.from.x, parentFace.to.y - parentFace.from.y);
  const childLength = Math.hypot(childFace.to.x - childFace.from.x, childFace.to.y - childFace.from.y);
  if (Math.abs(parentLength - childLength) > FACE_LENGTH_TOLERANCE * Math.max(parentLength, childLength)) {
    throw new Error(`face lengths differ: parent ${parentLength} vs child ${childLength} on "${primitive.id}"`);
  }

  const angle =
    Math.atan2(parentFace.from.y - parentFace.to.y, parentFace.from.x - parentFace.to.x) -
    Math.atan2(childFace.to.y - childFace.from.y, childFace.to.x - childFace.from.x);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const originX = parentFace.to.x - (cos * childFace.from.x - sin * childFace.from.y);
  const originY = parentFace.to.y - (sin * childFace.from.x + cos * childFace.from.y);
  const placed = localVertices.map((v) => ({
    x: originX + cos * v.x - sin * v.y,
    y: originY + sin * v.x + cos * v.y,
  }));
  return {
    id: primitive.id,
    shape: primitive.shape,
    phaseAngle: primitive.phaseAngle,
    vertices: placed,
    moments: polygonMomentsAboutOrigin(placed),
  };
}

// 反時計回りの頂点列の index 番目の辺。
function faceOf(vertices: readonly Vec2[], index: number, id: string): { from: Vec2; to: Vec2 } {
  if (!Number.isInteger(index) || index < 0 || index >= vertices.length) {
    throw new Error(`face index ${index} out of range on "${id}"`);
  }
  return { from: vertices[index]!, to: vertices[(index + 1) % vertices.length]! };
}

// 配置済みの2つの基本断面が重なっているとみなす、面積比の下限。突き合わせで辺だけを共有する
// 正しい貼り合わせでも、変換の丸めで幅0の細片が残りうるので、その分だけ余裕を取る。
const OVERLAP_AREA_RATIO = 1e-9;

// 辺 a→b の左側にあれば正になる符号付き量。
function sideOf(a: Vec2, b: Vec2, point: Vec2): number {
  return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
}

// 直線 a→b と線分 from→to の交点。呼び出し側が両端の側を確かめてから使う。
function edgeCrossing(a: Vec2, b: Vec2, from: Vec2, to: Vec2): Vec2 {
  const sFrom = sideOf(a, b, from);
  const t = sFrom / (sFrom - sideOf(a, b, to));
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

// 反時計回りの凸多角形どうしが重なる面積。突き合わせで辺だけを共有するときは0になる。
function convexOverlapArea(subject: readonly Vec2[], clip: readonly Vec2[]): number {
  let output: readonly Vec2[] = subject;
  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const input = output;
    const clipped: Vec2[] = [];
    for (let j = 0; j < input.length; j++) {
      const previous = input[(j + input.length - 1) % input.length]!;
      const current = input[j]!;
      const previousInside = sideOf(a, b, previous) >= 0;
      const currentInside = sideOf(a, b, current) >= 0;
      if (previousInside !== currentInside) clipped.push(edgeCrossing(a, b, previous, current));
      if (currentInside) clipped.push(current);
    }
    output = clipped;
  }
  return output.length < 3 ? 0 : Math.abs(polygonMomentsAboutOrigin(output).area);
}

// 配置済みの基本断面のうち、面積を分け合う組があれば例外を投げる。木構造として正しい断面でも
// 図形は重なりうるため、総和が幾何量になるかどうかはここで確かめてはじめて言える。
function requireDisjoint(placed: readonly PlacedPrimitive[]): void {
  for (let i = 0; i < placed.length; i++) {
    const a = placed[i]!;
    if (!a.vertices) continue;
    for (let j = i + 1; j < placed.length; j++) {
      const b = placed[j]!;
      if (!b.vertices) continue;
      const overlap = convexOverlapArea(a.vertices, b.vertices);
      const smaller = Math.min(Math.abs(a.moments.area), Math.abs(b.moments.area));
      if (overlap > OVERLAP_AREA_RATIO * smaller) {
        throw new Error(`primitives "${a.id}" and "${b.id}" overlap by ${overlap} m^2`);
      }
    }
  }
}

// 複合体を根から辿り、すべての基本断面を断面の座標系へ配置する。木構造として不正な断面
// (根が1つでない、親が存在しない、循環している、辺を持たない断面を子や親にしている、
// 貼り合わせる2辺の長さが違う)と、図形として重なる断面に対しては例外を投げる。
function placePrimitives(section: CrossSection): readonly PlacedPrimitive[] {
  const primitiveById = new Map<string, SectionPrimitive>();
  for (const primitive of section.primitives) {
    if (primitiveById.has(primitive.id)) throw new Error(`duplicate primitive id "${primitive.id}"`);
    primitiveById.set(primitive.id, primitive);
  }
  const roots = section.primitives.filter((primitive) => primitive.attachment === null);
  if (roots.length !== 1) throw new Error(`section needs exactly one root primitive, got ${roots.length}`);

  const childrenByParentId = new Map<string, { primitive: SectionPrimitive; attachment: PrimitiveAttachment }[]>();
  for (const primitive of section.primitives) {
    const attachment = primitive.attachment;
    if (!attachment) continue;
    if (!primitiveById.has(attachment.parentId)) {
      throw new Error(`primitive "${primitive.id}" attaches to unknown parent "${attachment.parentId}"`);
    }
    const siblings = childrenByParentId.get(attachment.parentId) ?? [];
    siblings.push({ primitive, attachment });
    childrenByParentId.set(attachment.parentId, siblings);
  }

  const placed: PlacedPrimitive[] = [placeRoot(roots[0]!)];
  for (let i = 0; i < placed.length; i++) {
    const parent = placed[i]!;
    for (const child of childrenByParentId.get(parent.id) ?? []) {
      placed.push(placeChild(child.primitive, child.attachment, parent));
    }
  }
  if (placed.length !== section.primitives.length) {
    throw new Error(`${section.primitives.length - placed.length} primitives are not reachable from the root`);
  }
  requireDisjoint(placed);
  return placed;
}

// 複合断面全体の面積・重心・重心まわりの断面二次モーメント。重ならない基本断面の総和として求まる。
// 木構造として不正な断面と、図形として重なる断面には例外を投げる。
export function sectionMoments(section: CrossSection): SectionMoments {
  let total = ZERO_MOMENTS;
  for (const primitive of placePrimitives(section)) {
    total = addMoments(total, primitive.moments);
  }
  return toCentroidal(total);
}

// 複合断面を構成する基本断面を、それぞれ断面の座標系へ配置して返す。順序は根から始まる幅優先で、
// 木構造として不正な断面と、図形として重なる断面には例外を投げる。
export function placeSectionPrimitives(section: CrossSection): readonly PlacedSectionPrimitive[] {
  return placePrimitives(section);
}
