// カプセル(線分を太らせた形)どうし・カプセルと球の接触の幾何。機体の狭域の当たりはこの形で取る —
// 外接球は細長い機体の内側の大半が空であり、弾丸がそこを通っても当たったことになる。
// 球は両端が一致するカプセルなので、球どうしの掃引はこの実装がそのまま含む。
import { Vec3, add, dot, len, scale, sub } from './vec3';

// 区間 [0,1] を線形に動くカプセル。始点と終点で軸の両端を与える。
export interface SweptCapsule {
  readonly aStart: Vec3;
  readonly bStart: Vec3;
  readonly aEnd: Vec3;
  readonly bEnd: Vec3;
  readonly radius: number;
}

export interface CapsuleContact {
  readonly toi: number; // 区間内の接触割合 0..1
  readonly normal: Vec3; // x から y へ向く単位法線
  readonly point: Vec3; // 接触点(両者の表面が触れる位置)
}

// 掃引の刻みを詰める反復の上限。接近が接線的な場合に打ち切る — 打ち切りは接触なしとして扱う。
const MAX_ADVANCE_STEPS = 64;

// 接触とみなす隙間の、半径和に対する相対許容差。
const GAP_TOLERANCE_RATIO = 1e-6;

// 球を、両端が一致する退化したカプセルとして表す。
export function sphereAsSweptCapsule(start: Vec3, end: Vec3, radius: number): SweptCapsule {
  return { aStart: start, bStart: start, aEnd: end, bEnd: end, radius };
}

// 2線分の最接近点を、それぞれの線分上の媒介変数 s, t (0..1) として返す。
// 平行で退化した場合も含めて、常に [0,1] に収まる値を返す。
export function closestPointsOnSegments(
  p0: Vec3, p1: Vec3, q0: Vec3, q1: Vec3,
): { readonly s: number; readonly t: number } {
  const d1 = sub(p1, p0);
  const d2 = sub(q1, q0);
  const r = sub(p0, q0);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  // どちらかが点に退化していれば、もう一方への垂線の足がそのまま答えになる。
  if (a <= 1e-18 && e <= 1e-18) return { s: 0, t: 0 };
  if (a <= 1e-18) return { s: 0, t: clamp01(f / e) };
  const c = dot(d1, r);
  if (e <= 1e-18) return { s: clamp01(-c / a), t: 0 };

  const b = dot(d1, d2);
  const denom = a * e - b * b;
  // 平行なら s を自由に取れるので 0 に置き、t 側だけを解く。
  let s = denom > 1e-18 ? clamp01((b * f - c * e) / denom) : 0;
  let t = (b * s + f) / e;
  // t を [0,1] へ丸めたら、その t に対して s を解き直す — 丸めた側を固定した最接近点になる。
  if (t < 0) {
    t = 0;
    s = clamp01(-c / a);
  } else if (t > 1) {
    t = 1;
    s = clamp01((b - c) / a);
  }
  return { s, t };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lerp(from: Vec3, to: Vec3, t: number): Vec3 {
  return add(from, scale(sub(to, from), t));
}

// 区間内の割合 t におけるカプセルの軸。
function axisAt(capsule: SweptCapsule, t: number): { readonly a: Vec3; readonly b: Vec3 } {
  return { a: lerp(capsule.aStart, capsule.aEnd, t), b: lerp(capsule.bStart, capsule.bEnd, t) };
}

// 端点が動く速さの上限。線分上の任意の点は両端の凸結合として動くので、その速さは両端の速さを
// 超えない。この値が隙間の変化率の上界になり、保守的前進の刻み幅を与える。
function endpointSpeedBound(capsule: SweptCapsule): number {
  return Math.max(
    len(sub(capsule.aEnd, capsule.aStart)),
    len(sub(capsule.bEnd, capsule.bStart)),
  );
}

function isFiniteVec(x: Vec3): boolean {
  return Number.isFinite(x.x) && Number.isFinite(x.y) && Number.isFinite(x.z);
}

function isFiniteCapsule(capsule: SweptCapsule): boolean {
  return isFiniteVec(capsule.aStart) && isFiniteVec(capsule.bStart)
    && isFiniteVec(capsule.aEnd) && isFiniteVec(capsule.bEnd)
    && Number.isFinite(capsule.radius) && capsule.radius >= 0;
}

// 区間内の割合 t における、2つのカプセルの隙間 [m](負なら重なり)と、x から y へ向く接触法線。
// 最接近点が一致して向きが決まらないときだけ normal が null になる。
export interface CapsuleGap {
  readonly gap: number;
  readonly normal: Vec3 | null;
  readonly point: Vec3;
}

export function capsuleGapAt(x: SweptCapsule, y: SweptCapsule, t: number): CapsuleGap {
  const ax = axisAt(x, t);
  const ay = axisAt(y, t);
  const { s, t: u } = closestPointsOnSegments(ax.a, ax.b, ay.a, ay.b);
  const px = lerp(ax.a, ax.b, s);
  const delta = sub(lerp(ay.a, ay.b, u), px);
  const distance = len(delta);
  const gap = distance - (x.radius + y.radius);
  if (!(distance > 1e-12)) return { gap, normal: null, point: px };
  const normal = scale(delta, 1 / distance);
  return { gap, normal, point: add(px, scale(normal, x.radius)) };
}

// 2つの掃引カプセルが最初に触れる時刻を返す。触れなければ null。
// 隙間は端点の速さで抑えた Lipschitz 定数を持つので、現在の隙間を最大接近速度で割った時間だけ
// 前進しても接触を跨げない(保守的前進)。1ステップが長い時間加速下でも貫通を取り落とさない。
// 区間の開始時点で既に重なっている場合は、掃引球と同じく離散 solver へ委ねるため null を返す。
export function sweptCapsuleToi(x: SweptCapsule, y: SweptCapsule): CapsuleContact | null {
  if (!isFiniteCapsule(x) || !isFiniteCapsule(y)) return null;
  const radiusSum = x.radius + y.radius;
  const tolerance = Math.max(radiusSum * GAP_TOLERANCE_RATIO, 1e-9);
  const speedBound = endpointSpeedBound(x) + endpointSpeedBound(y);

  const probe = (t: number): CapsuleGap => capsuleGapAt(x, y, t);

  // 開始時点で触れている(隙間が許容差以下の)場合は、掃引球と同じく離散 solver へ委ねる。
  let here = probe(0);
  if (!(here.gap > tolerance)) return null;
  // 相対的に動かないなら、開始時点で触れていない以上その後も触れない。
  if (!(speedBound > 0)) return null;

  let t = 0;
  for (let i = 0; i < MAX_ADVANCE_STEPS; i++) {
    t += here.gap / speedBound;
    if (t > 1) return null;
    here = probe(t);
    if (here.gap <= tolerance) {
      // 両者の最接近点が一致すると法線の向きが決まらない。
      if (here.normal === null) return null;
      return { toi: t, normal: here.normal, point: here.point };
    }
  }
  return null;
}

// 掃引カプセルと掃引球。球を退化したカプセルとして同じ判定へ通す。
export function sweptCapsuleSphereToi(
  capsule: SweptCapsule, sphereStart: Vec3, sphereEnd: Vec3, sphereRadius: number,
): CapsuleContact | null {
  return sweptCapsuleToi(capsule, sphereAsSweptCapsule(sphereStart, sphereEnd, sphereRadius));
}
