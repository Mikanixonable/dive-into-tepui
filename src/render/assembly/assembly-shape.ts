// 組み立て型の敵の形状モデル(SPEC/ASSEMBLY.md)。seed から決定論的に組み立てる部品の
// 集合で、表示・接触判定・被弾モデルが同じ部品一覧を共有する。THREE には依存しない。
import {
  add, addScaled, cross, dot, len, lenSq, norm, randPerp, randVec, scale, sub, v3, type Vec3,
} from '../../math/vec3';
import { mulberry32 } from '../../math/random';

// 部品の役割。発射部はプラズマ弾の発射元、中核は壊すと個体を撃破できる部位。
export type AssemblyPartRole = 'structure' | 'emitter' | 'core';
export type AssemblyPartKind = 'tube' | 'knot';

// 部品1個。中心線は敵ローカル座標 [m] の折れ線で、closed なら両端が接続する閉ループ。
export interface AssemblyPartDef {
  readonly index: number;
  readonly role: AssemblyPartRole;
  readonly kind: AssemblyPartKind;
  readonly centerline: readonly Vec3[];
  // 管半径 [m]。
  readonly radius: number;
  readonly closed: boolean;
}

export interface AssemblyShape {
  readonly seed: number;
  readonly parts: readonly AssemblyPartDef[];
  // 全球を覆う外接半径 [m]。接触の広域判定に使う。
  readonly outerRadius: number;
  // 発射部の先端(敵ローカル座標 [m])。
  readonly emitterTip: Vec3;
  // 部品の質量分布から求めた慣性の対角近似(最大成分で正規化)。個体ごとの回り方を決める。
  readonly inertia: Vec3;
}

// 個体の外接半径の範囲 [m]。金属の敵機(約 67〜94 m)と同程度より一回り小さい。
const OUTER_RADIUS_MIN = 40;
const OUTER_RADIUS_MAX = 70;
// 管半径の、外接半径に対する比率の範囲。
const TUBE_RADIUS_MIN = 0.08;
const TUBE_RADIUS_MAX = 0.12;
// 結び目として選ぶ (p,q) トーラス結び目。互いに素な組だけが1成分の結び目になる。
const TORUS_KNOTS: readonly (readonly [number, number])[] = [
  [2, 3], [2, 5], [2, 7], [3, 4], [3, 5], [4, 5],
];
// 結び目を全体の形として持つ個体の出る確率。
const WHOLE_KNOT_PROBABILITY = 0.35;
// 枝分かれ型の個体に局所的な結び目部品が付く確率。
const LOCAL_KNOT_PROBABILITY = 0.3;
// ランダムウォークの1ステップで曲がる角度の上限 [rad]。「緩やかに折れ曲がる」程度を決める。
const WALK_TURN_MAX = 0.6;
// ランダムウォークの1ステップの長さ(正規化前)。
const WALK_STEP = 1;

// seed から決定論的に1個体の形状を組む。
export function generateAssemblyShape(seed: number): AssemblyShape {
  const rand = mulberry32(seed);
  const rawParts = rand() < WHOLE_KNOT_PROBABILITY
    ? buildWholeKnot(rand)
    : buildBranched(rand);
  const { index: emitterIndex, tip: emitterTip } = pickEmitter(rawParts);
  const coreIndex = pickCore(rawParts, emitterIndex);

  // 目標の外接半径へ一様に縮めてから、役割を付けて確定する。
  const outerRadius = OUTER_RADIUS_MIN + rand() * (OUTER_RADIUS_MAX - OUTER_RADIUS_MIN);
  const k = outerRadius / shapeOuterRadius(rawParts);
  const parts = rawParts.map((part, index) => ({
    ...part,
    index,
    role: (index === emitterIndex ? 'emitter' : index === coreIndex ? 'core' : 'structure') as AssemblyPartRole,
    centerline: part.centerline.map((point) => scale(point, k)),
    radius: part.radius * k,
  }));
  return {
    seed, parts, outerRadius,
    emitterTip: scale(emitterTip, k),
    inertia: shapeInertia(parts),
  };
}

// 役割を持たない組み立て途中の部品。
interface RawPart {
  readonly kind: AssemblyPartKind;
  readonly centerline: readonly Vec3[];
  readonly radius: number;
  readonly closed: boolean;
}

// --- 部品の組み立て(正規化前の座標で組む) ---

// 種別 'branched': 折れ曲がる主鎖を節で分割し、枝と低確率の局所結び目を付ける。
function buildBranched(rand: () => number): RawPart[] {
  const tubeRadius = TUBE_RADIUS_MIN + rand() * (TUBE_RADIUS_MAX - TUBE_RADIUS_MIN);
  const parts: RawPart[] = [];

  // 主鎖。5〜8 節の歩行を平滑化してから 2〜4 個の部品へ分ける(分割点は折れ線の頂点を共有する)。
  const spine = gentleCenterline(
    v3(0, 0, 0), norm(v3(1, rand() - 0.5, rand() - 0.5)), 5 + Math.floor(rand() * 4), rand,
  );
  const bounds = evenSplit(spine.length - 1, 2 + Math.floor(rand() * 3));
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    parts.push({
      kind: 'tube', centerline: spine.slice(bounds[i]!, bounds[i + 1]! + 1),
      radius: tubeRadius, closed: false,
    });
  }

  // 枝。主鎖の中ほどの頂点から、外側へ折れ曲がりながら伸びる。
  const spineCenter = midpointOf(spine);
  const branchCount = Math.floor(rand() * 4);
  for (let i = 0; i < branchCount; i += 1) {
    const origin = spine[Math.floor(spine.length * (0.2 + rand() * 0.6))]!;
    const outward = norm(sub(origin, spineCenter));
    const base = lenSq(outward) > 1e-6 ? outward : randDir(rand);
    const dir = norm(addScaled(base, randPerp(base, rand), rand() * 0.8));
    parts.push({
      kind: 'tube', centerline: gentleCenterline(origin, dir, 2 + Math.floor(rand() * 3), rand),
      radius: tubeRadius, closed: false,
    });
  }

  // 局所結び目。主鎖の頂点へ寄せた小さなトーラス結び目の部品。
  if (rand() < LOCAL_KNOT_PROBABILITY) {
    const [p, q] = TORUS_KNOTS[Math.floor(rand() * TORUS_KNOTS.length)]!;
    const at = spine[Math.floor(spine.length * (0.3 + rand() * 0.4))]!;
    parts.push({
      kind: 'knot',
      centerline: torusKnotCenterline(p, q, 64).map((point) => add(at, scale(point, 1.2))),
      radius: tubeRadius, closed: true,
    });
  }
  return parts;
}

// 種別 'wholeKnot': 全体が1つのトーラス結び目。閉ループを弧で 2〜3 部品へ分け、付属の枝を持てる。
function buildWholeKnot(rand: () => number): RawPart[] {
  const tubeRadius = TUBE_RADIUS_MIN + rand() * (TUBE_RADIUS_MAX - TUBE_RADIUS_MIN);
  const [p, q] = TORUS_KNOTS[Math.floor(rand() * TORUS_KNOTS.length)]!;
  // 頂点を1つ重ねて、切れ目の端面が隣の管へ埋まるようにする。
  const knot = torusKnotCenterline(p, q, 96);
  const parts: RawPart[] = [];
  const bounds = evenSplit(knot.length - 1, 2 + Math.floor(rand() * 2));
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    parts.push({
      kind: 'knot', centerline: knot.slice(bounds[i]!, bounds[i + 1]! + 1),
      radius: tubeRadius, closed: false,
    });
  }

  // 付属の枝。結び目の外縁の頂点から外側へ伸びる。
  const branchCount = Math.floor(rand() * 3);
  for (let i = 0; i < branchCount; i += 1) {
    const origin = knot[Math.floor(rand() * (knot.length - 1))]!;
    const base = norm(origin);
    const dir = norm(addScaled(base, randPerp(base, rand), rand() * 0.6));
    parts.push({
      kind: 'tube', centerline: gentleCenterline(origin, dir, 2 + Math.floor(rand() * 2), rand),
      radius: tubeRadius, closed: false,
    });
  }
  return parts;
}

// --- 中心線の生成 ---

// 緩やかに折れ曲がる管の中心線を、steps 回のランダムウォーク + Catmull-Rom 平滑化で組む。
function gentleCenterline(
  start: Vec3, dir: Vec3, steps: number, rand: () => number,
): Vec3[] {
  const controls: Vec3[] = [start];
  let position = start;
  let heading = dir;
  for (let i = 0; i < steps; i += 1) {
    heading = bend(heading, rand);
    position = addScaled(position, heading, WALK_STEP);
    controls.push(position);
  }
  return sampleCatmullRom(controls, 6);
}

// 進行方向を、直交するランダム軸まわりに WALK_TURN_MAX 以下で回す(ロドリゲスの回転)。
function bend(heading: Vec3, rand: () => number): Vec3 {
  const axis = randPerp(heading, rand);
  const angle = rand() * WALK_TURN_MAX;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return norm(addScaled(
    addScaled(scale(heading, c), cross(axis, heading), s), axis, dot(axis, heading) * (1 - c),
  ));
}

// 立方体内一様の乱数から単位方向を引く。退化したベクトルは引き直す。
function randDir(rand: () => number): Vec3 {
  for (;;) {
    const v = norm(randVec(1, rand));
    if (lenSq(v) > 1e-6) return v;
  }
}

// 開いた制御点列を一様 Catmull-Rom で密な折れ線へ写す。両端は端点を重ねて延ばす。
function sampleCatmullRom(controls: readonly Vec3[], samplesPerSpan: number): Vec3[] {
  const p = [controls[0]!, ...controls, controls[controls.length - 1]!];
  const points: Vec3[] = [];
  for (let i = 0; i + 3 < p.length; i += 1) {
    for (let j = 0; j < samplesPerSpan; j += 1) {
      points.push(catmullRomPoint(p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!, j / samplesPerSpan));
    }
  }
  points.push(controls[controls.length - 1]!);
  return points;
}

// 区間 [p1, p2] 上の Catmull-Rom 補間点。
function catmullRomPoint(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const at = (a: number, b: number, c: number, d: number): number => (
    0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3)
  );
  return v3(at(p0.x, p1.x, p2.x, p3.x), at(p0.y, p1.y, p2.y, p3.y), at(p0.z, p1.z, p2.z, p3.z));
}

// (p,q) トーラス結び目の中心線を count 点の閉折れ線で返す(最終点は始点と同じ)。
function torusKnotCenterline(p: number, q: number, count: number): Vec3[] {
  const bigR = 0.72;
  const smallR = 0.28;
  const points: Vec3[] = [];
  for (let i = 0; i <= count; i += 1) {
    const phi = (i / count) * Math.PI * 2;
    const r = bigR + smallR * Math.cos(q * phi);
    points.push(v3(r * Math.cos(p * phi), r * Math.sin(p * phi), smallR * Math.sin(q * phi)));
  }
  return points;
}

// --- 役割と寸法 ---

// 発射部: 開放端を持つ部品のうち、端が全体の中心から最も遠いもの。その端を先端とする。
function pickEmitter(parts: readonly RawPart[]): { index: number; tip: Vec3 } {
  const center = midpointOf(parts.flatMap((part) => [...part.centerline]));
  let emitter = 0;
  let tip = parts[0]!.centerline[0]!;
  let farthest = -1;
  parts.forEach((part, index) => {
    if (part.closed) return;
    for (const end of [part.centerline[0]!, part.centerline[part.centerline.length - 1]!]) {
      const d = lenSq(sub(end, center));
      if (d > farthest) {
        farthest = d;
        emitter = index;
        tip = end;
      }
    }
  });
  return { index: emitter, tip };
}

// 中核: 中心線の中点が全体の中心に最も近い、発射部でない部品。
function pickCore(parts: readonly RawPart[], emitterIndex: number): number {
  const center = midpointOf(parts.flatMap((part) => [...part.centerline]));
  let core = emitterIndex;
  let nearest = Infinity;
  parts.forEach((part, index) => {
    if (index === emitterIndex) return;
    const d = lenSq(sub(midpointOf(part.centerline), center));
    if (d < nearest) {
      nearest = d;
      core = index;
    }
  });
  return core;
}

// 部品の輪郭を含む外接半径(正規化前)。
function shapeOuterRadius(parts: readonly RawPart[]): number {
  let maxReach = 0;
  for (const part of parts) {
    for (const point of part.centerline) maxReach = Math.max(maxReach, len(point) + part.radius);
  }
  return maxReach;
}

// 折れ線の添字区間 [0, n] を count 個のほぼ等しい区切りへ分ける境界添字列(長さ count+1)。
function evenSplit(n: number, count: number): number[] {
  const bounds: number[] = [];
  for (let i = 0; i <= count; i += 1) bounds.push(Math.round((n * i) / count));
  return bounds;
}

// 折れ線の重心。
function midpointOf(points: readonly Vec3[]): Vec3 {
  return scale(
    points.reduce((acc, point) => add(acc, point), v3(0, 0, 0)),
    1 / points.length,
  );
}

// 部品の中心線を質量 len*radius² の点列とみなした慣性テンソルの対角成分(最大で正規化)。
function shapeInertia(parts: readonly AssemblyPartDef[]): Vec3 {
  let ixx = 0;
  let iyy = 0;
  let izz = 0;
  for (const part of parts) {
    for (let i = 0; i + 1 < part.centerline.length; i += 1) {
      const a = part.centerline[i]!;
      const b = part.centerline[i + 1]!;
      const mass = len(sub(b, a)) * part.radius * part.radius;
      const mid = scale(add(a, b), 0.5);
      ixx += mass * (mid.y * mid.y + mid.z * mid.z);
      iyy += mass * (mid.x * mid.x + mid.z * mid.z);
      izz += mass * (mid.x * mid.x + mid.y * mid.y);
    }
  }
  const max = Math.max(ixx, iyy, izz);
  return max > 0 ? v3(ixx / max, iyy / max, izz / max) : v3(1, 1, 1);
}
