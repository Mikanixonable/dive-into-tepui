// 結節体(SPEC/KNOT.md)1体の形状生成。パラメーターから中心線(閉曲線)を組み、
// 回転最小の平行移動フレームで管(索)を掃引し、材質区間ごとの頂点列・球列の当たり
// 判定形状・セグメント分割・結節ノード・駆動中核を返す純関数だけを持つ。同じ
// パラメーターからは常に同じ個体が得られ、形そのものは保存しない(seed と損傷だけを
// 保存し、形はここから組み直す)。import を持たない定義層のモジュールとして置く —
// ゲーム側と描画側のどちらからも、層の境界を越えずに引けるようにするためであり、
// ベクトル演算と乱数もこの中で閉じる。

// 中心線の族。8の字は独立の族にせず、編みによって交差の形として作る(KNOT.md)。
export type KnotFamily = 'torus' | 'lissajous';

// 結節ノードの役割。射撃は K4 でこの役のノードが担う。
export type KnotNodeRole = 'shooter' | 'sensor' | 'drive';

// ローカル座標の点 [m]。生成の中ではタプルで持ち、消費側が自分のベクトル型へ写す。
export type KnotPoint = readonly [number, number, number];

// 弾の命中先。着弾点に最も近い部位へ割り当てるための分類(KNOT.md「戦闘状態」)。
export type KnotHitTarget =
  | { readonly part: 'segment'; readonly index: number }
  | { readonly part: 'node'; readonly index: number }
  | { readonly part: 'core' };

// 個体を決めるパラメーター。範囲外の値は normalizeKnotParams が実用域へ収める。
export interface KnotParams {
  readonly family: KnotFamily;
  // トーラス族: 軸まわりの巻数 p と管まわりの巻数 q。互いに素でないと結び目にならない。
  readonly torusP: number;
  readonly torusQ: number;
  // リサージュ族: 軸ごとの周波数(整数でないと閉じない)と、y / z の位相 [rad]。
  readonly freqX: number;
  readonly freqY: number;
  readonly freqZ: number;
  readonly phaseY: number;
  readonly phaseZ: number;
  // 結び目全体の大きさの代表半径 [m]。実用域は 100〜300。
  readonly mainRadius: number;
  // 索の半径 = mainRadius × tubeRatio。実用域は 0.08〜0.18。
  readonly tubeRatio: number;
  // 索の本数 1〜3。2本以上は同じ中心線を位相ずらしで重ねる編み込みになる。
  readonly strands: number;
  // 編みの巻き数(中心線1周あたり、索の中心が中心線のまわりを回る回数)。
  readonly weaveTurns: number;
  // 膨らみ変調: 半径 = 索の半径 × (1 + bulgeAmp × cos(2π × bulgeFreq × s + bulgePhase))。
  readonly bulgeAmp: number;
  readonly bulgeFreq: number;
  readonly bulgePhase: number;
  // ほつれ度 0〜1。0 で完全な閉結び目、大きいほど中心線の末尾を切り落として両端を開く。
  readonly fray: number;
  // 個体差(位相の微調整・素線パッチ・ノードとデブリの配置)を決める乱数種。
  readonly seed: number;
  // 結節ノード(役割を持つ機械の塊)の数。
  readonly nodeCount: number;
}

// 材質1種ぶんの管ジオメトリ。色は線形 RGB の頂点カラー。
export interface KnotMeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  readonly vertexCount: number;
  readonly triangleCount: number;
}

// 索1本の形状。中心線と、それに沿う平行移動フレーム(法線・従法線)。
export interface KnotStrandShape {
  readonly centerline: readonly KnotPoint[];
  readonly normals: readonly KnotPoint[];
  readonly binormals: readonly KnotPoint[];
  readonly closed: boolean;
  // この索の管半径 [m]。
  readonly tubeRadius: number;
}

// 当たり判定の球1個。segment は所属するセグメントの番号。
export interface KnotSphere {
  readonly center: KnotPoint;
  readonly radius: number;
  readonly segment: number;
}

// 索の区間。球列の連続した並びで、HP を持つ単位(KNOT.md のセグメント)。
export interface KnotSegmentShape {
  readonly index: number;
  readonly strand: number;
  // shape.spheres の中の開始位置と球の数。
  readonly sphereStart: number;
  readonly sphereCount: number;
  // 区間の代表点(中央の球の中心)。損傷の表示位置などに使う。
  readonly midpoint: KnotPoint;
}

// 結節ノードの配置。役割を持ち、中心線の上に埋まる機械の塊。
export interface KnotNodeShape {
  readonly index: number;
  readonly role: KnotNodeRole;
  readonly position: KnotPoint;
  readonly radius: number;
  readonly strand: number;
}

// 駆動中核。結び目の中心にあり、索に囲まれて隠れる。
export interface KnotCoreShape {
  readonly position: KnotPoint;
  readonly radius: number;
}

// 編み込まれたデブリ片の配置。rotation は Euler 角 [rad]、size は板の寸法 [m]。
export interface KnotDebrisPlacement {
  readonly position: KnotPoint;
  readonly rotation: KnotPoint;
  readonly size: KnotPoint;
}

export interface KnotShape {
  // 実用域へ収めた、実際に使ったパラメーター。
  readonly params: KnotParams;
  readonly strands: readonly KnotStrandShape[];
  // 摩耗した被覆の索と、素線が露出した区間の索。
  readonly sheath: KnotMeshData;
  readonly bare: KnotMeshData;
  // 全索の判定球(索の順、索の中では中心線の順)。中核とノードの球は含まない。
  readonly spheres: readonly KnotSphere[];
  readonly segments: readonly KnotSegmentShape[];
  readonly nodes: readonly KnotNodeShape[];
  readonly core: KnotCoreShape;
  readonly debris: readonly KnotDebrisPlacement[];
  readonly vertexCount: number;
  readonly triangleCount: number;
  // 原点から全体を包む半径 [m]。接触の広域判定と構図決めに使う。
  readonly outerRadius: number;
  // 質量分布から求めた慣性の対角近似(最大成分で正規化)。個体ごとの回り方を決める。
  readonly inertia: KnotPoint;
}

// 実用域(KNOT.md「構成と表示」)。
export const KNOT_MAIN_RADIUS_MIN = 100;
export const KNOT_MAIN_RADIUS_MAX = 300;
export const KNOT_TUBE_RATIO_MIN = 0.08;
export const KNOT_TUBE_RATIO_MAX = 0.18;

// トーラス族で、中心線がトーラス面から膨らむ割合。主半径に対してこの割合の管の
// まわりを中心線が巻く。
const TORUS_TUBE_RATIO = 0.42;
// リサージュ族の軸ごとの潰し。全軸が同じ振幅だと球状の団子になりやすいので、
// y / z を少し潰して結び目の広がりを出す。
const LISSAJOUS_AXIS_SCALE = [1, 0.88, 0.74] as const;
// seed から選ぶトーラス結び目(互いに素な (p, q))とリサージュ周波数の組。
const TORUS_KNOT_PAIRS: readonly (readonly [number, number])[] = [
  [2, 3], [2, 5], [2, 7], [3, 4], [3, 5],
];
const LISSAJOUS_FREQ_SETS: readonly (readonly [number, number, number])[] = [
  [3, 4, 7], [3, 5, 8], [5, 6, 11],
];
// 巻数が大きい形の判定。これに編みとほつれを重ねると判読できない塊になるので、
// normalizeKnotParams が編み(索1本化)とほつれ(0)を切り離す(KNOT.md)。
const TORUS_HIGH_WINDING = 5;
const LISSAJOUS_HIGH_WINDING_SUM = 15;
// ほつれ度 1 のときに切り落とす中心線の割合と、端の変位が及ぶ端からの長さ(割合)。
const FRAY_CUT_RATIO = 0.32;
const FRAY_END_SPAN = 0.1;
// 管の断面の分割数。
const RADIAL_SEGMENTS = 12;
// 中心線を引くときの稠密な標本数。弧長で引き直すための元表に使う。
const DENSE_SAMPLES = 3000;
// リング間隔の目安(索の半径に対する比)と、リング数の上下限。
const RING_SPACING_RATIO = 1.1;
const RING_COUNT_MIN = 160;
const RING_COUNT_MAX = 640;
// 隣り合う区間の向きの変化の上限 [rad]。これを超える箇所は弧の中点で割って細かく
// する — フレームの折れは、1区間での接線の回転が大きいところで起きるため。
const FRAME_STEP_ANGLE_MAX = Math.PI / 10;
const SUBDIVIDE_HARD_MAX = 2000;
// 判定球の半径は、膨らみの山まで覆うよう索の半径 × (1 + bulgeAmp) に取る。球の
// 間隔はその半径に対する比で、中心線が球の外へ出ないよう 2 未満に取る。
const SPHERE_SPACING_RATIO = 0.9;
// セグメント1つが持つ判定球の数。
export const KNOT_SEGMENT_SPHERES = 8;
// 結節ノードと中核の半径(索の半径に対する比)。管から頭を出す大きさにする。
const NODE_RADIUS_RATIO = 1.7;
const CORE_RADIUS_RATIO = 1.5;
// 被覆と素線の基調色(線形 RGB)。数十年漂って退色した被覆と、明るい金属灰。
const SHEATH_BASE_COLOR = [0.21, 0.2, 0.168] as const;
const BARE_BASE_COLOR = [0.4, 0.42, 0.46] as const;
// 索の撚りの回数(中心線1周あたり)。断面の角と組み合わさって螺旋の縞になる。
const TWIST_TURNS = 90;

// seed から決定的に乱数を引く(mulberry32)。同じ seed とパラメーターからは常に
// 同じ形が出ること(決定的生成)を、この1関数が担う。
function rngOf(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Vec3 = [number, number, number];

function sub(a: KnotPoint, b: KnotPoint): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function addScaled(a: KnotPoint, v: KnotPoint, scale: number): Vec3 {
  return [a[0] + v[0] * scale, a[1] + v[1] * scale, a[2] + v[2] * scale];
}
function dot(a: KnotPoint, b: KnotPoint): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: KnotPoint, b: KnotPoint): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function length(a: KnotPoint): number { return Math.hypot(a[0], a[1], a[2]); }
function normalize(a: KnotPoint): Vec3 {
  const len = length(a);
  return len > 0 ? [a[0] / len, a[1] / len, a[2] / len] : [1, 0, 0];
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }

// 単位軸 axis まわりに angle [rad] だけ v を回す(Rodrigues)。
function rotateAboutAxis(v: KnotPoint, axis: KnotPoint, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return addScaled(
    addScaled([v[0] * c, v[1] * c, v[2] * c], cross(axis, v), s),
    axis, dot(axis, v) * (1 - c),
  );
}

// 巻数が大きい形か。編み・ほつれとの重ねがけ判定に使う。
function isHighWinding(params: KnotParams): boolean {
  return params.family === 'torus'
    ? Math.max(params.torusP, params.torusQ) >= TORUS_HIGH_WINDING
    : params.freqX + params.freqY + params.freqZ >= LISSAJOUS_HIGH_WINDING_SUM;
}

// パラメーターを実用域へ収める。範囲はクランプし、トーラスは互いに素へ、
// リサージュは周波数の公約数を割って(同じ結び目を重ねて辿らない)、巻数の大きな
// 形からは編みとほつれを外す。決定的で、同じ入力には同じ出力を返す。
export function normalizeKnotParams(params: KnotParams): KnotParams {
  let torusP = clamp(Math.round(params.torusP), 2, 7);
  let torusQ = clamp(Math.round(params.torusQ), 2, 7);
  if (gcd(torusP, torusQ) !== 1) {
    // q をずらして互いに素にする。7 を超えたら p の側をずらす。
    while (gcd(torusP, torusQ) !== 1) {
      if (torusQ < 7) torusQ += 1;
      else { torusP = torusP > 2 ? torusP - 1 : torusP + 1; torusQ = 2; }
    }
  }
  let freqX = clamp(Math.round(params.freqX), 1, 11);
  let freqY = clamp(Math.round(params.freqY), 1, 11);
  let freqZ = clamp(Math.round(params.freqZ), 1, 11);
  const common = gcd(gcd(freqX, freqY), freqZ);
  if (common > 1) { freqX /= common; freqY /= common; freqZ /= common; }
  const normalized: KnotParams = {
    family: params.family,
    torusP, torusQ, freqX, freqY, freqZ,
    phaseY: params.phaseY, phaseZ: params.phaseZ,
    mainRadius: clamp(params.mainRadius, KNOT_MAIN_RADIUS_MIN, KNOT_MAIN_RADIUS_MAX),
    tubeRatio: clamp(params.tubeRatio, KNOT_TUBE_RATIO_MIN, KNOT_TUBE_RATIO_MAX),
    strands: clamp(Math.round(params.strands), 1, 3),
    weaveTurns: clamp(Math.round(params.weaveTurns), 6, 30),
    bulgeAmp: clamp(params.bulgeAmp, 0, 0.35),
    bulgeFreq: clamp(Math.round(params.bulgeFreq), 1, 12),
    bulgePhase: params.bulgePhase,
    fray: clamp(params.fray, 0, 0.7),
    seed: params.seed,
    nodeCount: clamp(Math.round(params.nodeCount), 3, 9),
  };
  if (!isHighWinding(normalized)) return normalized;
  return { ...normalized, strands: 1, fray: 0 };
}

// seed から1個体ぶんのパラメーターを引く。物語の個体は明示パラメーター、量産の
// 個体は seed で置くための入口(設計書 §4.4)。
export function knotParamsFromSeed(seed: number): KnotParams {
  const rand = rngOf(seed);
  const family: KnotFamily = rand() < 0.55 ? 'torus' : 'lissajous';
  const pair = TORUS_KNOT_PAIRS[Math.floor(rand() * TORUS_KNOT_PAIRS.length)]!;
  const freqs = LISSAJOUS_FREQ_SETS[Math.floor(rand() * LISSAJOUS_FREQ_SETS.length)]!;
  const strandRoll = rand();
  return normalizeKnotParams({
    family,
    torusP: pair[0], torusQ: pair[1],
    freqX: freqs[0], freqY: freqs[1], freqZ: freqs[2],
    phaseY: rand() * Math.PI * 2, phaseZ: rand() * Math.PI * 2,
    mainRadius: KNOT_MAIN_RADIUS_MIN + rand() * (KNOT_MAIN_RADIUS_MAX - KNOT_MAIN_RADIUS_MIN),
    tubeRatio: KNOT_TUBE_RATIO_MIN + rand() * (KNOT_TUBE_RATIO_MAX - KNOT_TUBE_RATIO_MIN),
    strands: strandRoll < 0.45 ? 1 : strandRoll < 0.8 ? 2 : 3,
    weaveTurns: 10 + Math.floor(rand() * 10),
    bulgeAmp: 0.12 + rand() * 0.18,
    bulgeFreq: 3 + Math.floor(rand() * 6),
    bulgePhase: rand() * Math.PI * 2,
    fray: rand() < 0.5 ? 0 : rand() * 0.6,
    seed,
    nodeCount: 4 + Math.floor(rand() * 4),
  });
}

// 族の閉形式で、中心線のパラメーター s(0〜1)の点を返す。
function centerlinePoint(params: KnotParams, s: number): Vec3 {
  const t = 2 * Math.PI * s;
  const r = params.mainRadius;
  if (params.family === 'torus') {
    const tube = r * TORUS_TUBE_RATIO;
    const ring = r + tube * Math.cos(params.torusQ * t);
    return [ring * Math.cos(params.torusP * t), ring * Math.sin(params.torusP * t), tube * Math.sin(params.torusQ * t)];
  }
  return [
    LISSAJOUS_AXIS_SCALE[0] * r * Math.sin(params.freqX * t),
    LISSAJOUS_AXIS_SCALE[1] * r * Math.sin(params.freqY * t + params.phaseY),
    LISSAJOUS_AXIS_SCALE[2] * r * Math.sin(params.freqZ * t + params.phaseZ),
  ];
}

// 中心線を稠密に引いた弧長の元表。ほつれの端の開きと、先細り(taper)をここで
// 付ける — 弧長で引き直す前に付けないと、開きで伸びたぶんが間隔へ響く。
interface DenseCurve {
  readonly points: Vec3[];
  readonly taper: number[];
  readonly cumulative: number[];
  readonly totalLength: number;
  readonly closed: boolean;
  readonly keep: number;
}

function buildDenseCenterline(params: KnotParams): DenseCurve {
  const fray = params.fray;
  const closed = fray <= 0;
  const keep = 1 - FRAY_CUT_RATIO * fray;
  const count = DENSE_SAMPLES;
  const points: Vec3[] = [];
  for (let i = 0; i < count; i += 1) {
    const s = closed ? i / count : (keep * i) / (count - 1);
    points.push(centerlinePoint(params, s));
  }
  const taper = new Array<number>(count).fill(1);
  if (!closed) {
    // 開いた両端は、重心から外向きと接線方向へ開く。宇宙空間に「垂れ」の向きは
    // 無いので、ほどけた端が拘束から解けて広がる向きとしてこの2方向を使う。
    const centroid: Vec3 = [0, 0, 0];
    for (const p of points) { centroid[0] += p[0]; centroid[1] += p[1]; centroid[2] += p[2]; }
    centroid[0] /= count; centroid[1] /= count; centroid[2] /= count;
    const openEnd = (endIndex: number, tangentSign: number): void => {
      const end = points[endIndex]!;
      const outward = normalize(sub(end, centroid));
      const tangent = normalize(sub(points[endIndex + tangentSign]!, end));
      for (let i = 0; i < count; i += 1) {
        const distance = Math.abs(i - endIndex) / (count - 1) / keep;
        if (distance >= FRAY_END_SPAN) continue;
        const u = distance / FRAY_END_SPAN;
        const w = (1 - u) * (1 - u) * fray;
        points[i] = addScaled(
          addScaled(points[i]!, outward, params.mainRadius * 0.38 * w),
          tangent, -tangentSign * params.mainRadius * 0.22 * w,
        );
        taper[i] = Math.min(taper[i]!, 1 - 0.85 * w);
      }
    };
    openEnd(0, 1);
    openEnd(count - 1, -1);
  }
  const cumulative = new Array<number>(count).fill(0);
  let total = 0;
  for (let i = 1; i < count; i += 1) {
    total += length(sub(points[i]!, points[i - 1]!));
    cumulative[i] = total;
  }
  if (closed) total += length(sub(points[0]!, points[count - 1]!));
  return { points, taper, cumulative, totalLength: total, closed, keep };
}

// 弧長 u [m] の点を元表から線形補間で引く。u は [0, totalLength] に丸める。
function densePointAt(dense: DenseCurve, u: number): { point: Vec3; taper: number } {
  const count = dense.points.length;
  const target = clamp(u, 0, dense.totalLength);
  // 歩行ポインタは呼び出し側の単調な走査で持つので、ここでは二分探索で区間を引く。
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (dense.cumulative[mid]! <= target) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const start = dense.cumulative[i]!;
  const isWrap = dense.closed && i === count - 1;
  const nextPoint = isWrap ? dense.points[0]! : dense.points[Math.min(count - 1, i + 1)]!;
  const nextArc = isWrap ? dense.totalLength : (dense.cumulative[i + 1] ?? dense.totalLength);
  const span = nextArc - start;
  const f = span > 0 ? (target - start) / span : 0;
  return {
    point: addScaled(dense.points[i]!, sub(nextPoint, dense.points[i]!), f),
    taper: dense.taper[i]! + ((isWrap ? dense.taper[0]! : dense.taper[Math.min(count - 1, i + 1)]!) - dense.taper[i]!) * f,
  };
}

// 中心線を弧長一様へ引き直し、曲がりの急な箇所は弧の中点で割って細かくした点列。
// パラメーター一様の標本では、高曲率の箇所で1区間の接線の回転が大きくなり、
// フレームが折れる(K0 の既知欠陥)。弧長一様 + 角度上限の細分で、回転を区間ごとに
// FRAME_STEP_ANGLE_MAX 以下へ抑える。
interface CenterlineSamples {
  readonly points: Vec3[];
  readonly taper: number[];
  // 各点の弧長 [m] と、元のパラメーター s(位相の計算に使う)。
  readonly arcs: number[];
  readonly totalLength: number;
  readonly closed: boolean;
}

function sampleCenterline(dense: DenseCurve, tubeRadius: number): CenterlineSamples {
  // リング数の目安: 間隔の目安と、曲がりの総量から要る下限の大きいほう。
  let totalTurning = 0;
  const denseCount = dense.points.length;
  const denseSegments = dense.closed ? denseCount : denseCount - 1;
  for (let i = 0; i < denseSegments; i += 1) {
    const a = dense.points[i]!;
    const b = dense.points[(i + 1) % denseCount]!;
    const c = dense.points[(i + 2) % denseCount]!;
    if (!dense.closed && i + 2 > denseCount - 1) break;
    const d1 = normalize(sub(b, a));
    const d2 = normalize(sub(c, b));
    totalTurning += Math.acos(clamp(dot(d1, d2), -1, 1));
  }
  const count = clamp(
    Math.max(
      Math.round(dense.totalLength / (tubeRadius * RING_SPACING_RATIO)),
      Math.ceil(totalTurning / FRAME_STEP_ANGLE_MAX),
      RING_COUNT_MIN,
    ),
    RING_COUNT_MIN, RING_COUNT_MAX,
  );
  let points: Vec3[] = [];
  let taper: number[] = [];
  let arcs: number[] = [];
  const resample = (n: number): void => {
    points = []; taper = []; arcs = [];
    for (let i = 0; i < n; i += 1) {
      const u = dense.closed ? (dense.totalLength * i) / n : (dense.totalLength * i) / (n - 1);
      const sampled = densePointAt(dense, u);
      points.push(sampled.point);
      taper.push(sampled.taper);
      arcs.push(u);
    }
  };
  resample(count);
  // 局所的に急な曲がりは、その前後の区間を弧の中点で割ってほぐす。
  for (let pass = 0; pass < 10 && points.length < SUBDIVIDE_HARD_MAX; pass += 1) {
    const n = points.length;
    const segmentCount = dense.closed ? n : n - 1;
    const split = new Set<number>();
    for (let i = 0; i < n; i += 1) {
      const prev = points[dense.closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!;
      const next = points[dense.closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!;
      const here = points[i]!;
      if (prev === here || next === here) continue;
      const d1 = normalize(sub(here, prev));
      const d2 = normalize(sub(next, here));
      if (Math.acos(clamp(dot(d1, d2), -1, 1)) <= FRAME_STEP_ANGLE_MAX) continue;
      // 曲がり点の前後の区間を割る。
      if (dense.closed || i > 0) split.add(dense.closed ? (i - 1 + n) % n : i - 1);
      if (dense.closed || i < n - 1) split.add(i);
    }
    if (split.size === 0) break;
    const nextPoints: Vec3[] = [];
    const nextTaper: number[] = [];
    const nextArcs: number[] = [];
    for (let seg = 0; seg < segmentCount; seg += 1) {
      nextPoints.push(points[seg]!);
      nextTaper.push(taper[seg]!);
      nextArcs.push(arcs[seg]!);
      if (!split.has(seg)) continue;
      const endArc = dense.closed && seg === n - 1 ? dense.totalLength : arcs[seg + 1]!;
      const mid = (arcs[seg]! + endArc) / 2;
      const sampled = densePointAt(dense, mid);
      nextPoints.push(sampled.point);
      nextTaper.push(sampled.taper);
      nextArcs.push(mid);
    }
    if (!dense.closed) {
      nextPoints.push(points[n - 1]!);
      nextTaper.push(taper[n - 1]!);
      nextArcs.push(arcs[n - 1]!);
    }
    points = nextPoints; taper = nextTaper; arcs = nextArcs;
  }
  return { points, taper, arcs, totalLength: dense.totalLength, closed: dense.closed };
}

// 点列に沿って回転最小の平行移動フレームを伝播させる。前のフレームを、接線を
// 次の接線へ移す最小回転で回して運ぶ — 法線を次の接線の平面へ射影する方式は、
// 1区間の回転が大きいところで法線が倒れて管が折れる。閉曲線では一周後の法線の
// ずれ角を全区間へ線形に分散して閉じる。
function transportFrames(
  points: readonly KnotPoint[], closed: boolean,
): { normals: Vec3[]; binormals: Vec3[] } {
  const count = points.length;
  const tangents: Vec3[] = points.map((_, i) => {
    const prev = points[closed ? (i - 1 + count) % count : Math.max(0, i - 1)]!;
    const next = points[closed ? (i + 1) % count : Math.min(count - 1, i + 1)]!;
    return normalize(sub(next, prev));
  });
  // 初期法線は、接線と最も平行でない軸を接線へ射影して作る。
  const t0 = tangents[0]!;
  const axis: Vec3 = Math.abs(t0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const first = normalize(sub(axis, [t0[0] * dot(axis, t0), t0[1] * dot(axis, t0), t0[2] * dot(axis, t0)]));
  const normals: Vec3[] = [first];
  for (let i = 1; i < count; i += 1) {
    const from = tangents[i - 1]!;
    const to = tangents[i]!;
    const rotationAxis = cross(from, to);
    const sin = length(rotationAxis);
    const cos = clamp(dot(from, to), -1, 1);
    let normal = normals[i - 1]!;
    if (sin > 1e-9) {
      normal = rotateAboutAxis(normal, [rotationAxis[0] / sin, rotationAxis[1] / sin, rotationAxis[2] / sin], Math.atan2(sin, cos));
    } else if (cos < 0) {
      // 接線が反転する区間は角度上限の細分で生じないはずだが、倒れたときは
      // 法線まわりの π 回転で接線だけを反転させ、法線の向きを保つ。
      normal = rotateAboutAxis(normal, normal, Math.PI);
    }
    normals.push(normalize(normal));
  }
  if (closed) {
    const from = tangents[count - 1]!;
    const rotationAxis = cross(from, t0);
    const sin = length(rotationAxis);
    const cos = clamp(dot(from, t0), -1, 1);
    let wrapped = normals[count - 1]!;
    if (sin > 1e-9) {
      wrapped = rotateAboutAxis(wrapped, [rotationAxis[0] / sin, rotationAxis[1] / sin, rotationAxis[2] / sin], Math.atan2(sin, cos));
    }
    const twist = Math.atan2(dot(cross(first, wrapped), t0), dot(first, wrapped));
    for (let i = 1; i < count; i += 1) {
      normals[i] = normalize(rotateAboutAxis(normals[i]!, tangents[i]!, (-twist * i) / count));
    }
  }
  const binormals = tangents.map((t, i) => cross(t, normals[i]!));
  return { normals, binormals };
}

// 材質ごとの頂点列を貯める器。リング(断面)単位で材質が決まるので、同じ材質の
// リングが続くあいだだけ四角を張る。材質の境界では頂点が重複するが位置は一致する。
interface MeshAccumulator {
  positions: number[];
  normals: number[];
  colors: number[];
  uvs: number[];
  indices: number[];
  lastRingStart: number;
}

function createMeshAccumulator(): MeshAccumulator {
  return { positions: [], normals: [], colors: [], uvs: [], indices: [], lastRingStart: -1 };
}

function addRing(
  acc: MeshAccumulator,
  ring: readonly { position: Vec3; normal: Vec3; color: Vec3; u: number; v: number }[],
  connect: boolean,
): void {
  const start = acc.positions.length / 3;
  for (const vertex of ring) {
    acc.positions.push(...vertex.position);
    acc.normals.push(...vertex.normal);
    acc.colors.push(...vertex.color);
    acc.uvs.push(vertex.u, vertex.v);
  }
  if (connect && acc.lastRingStart >= 0) {
    const m = ring.length;
    for (let j = 0; j < m; j += 1) {
      const a = acc.lastRingStart + j;
      const b = acc.lastRingStart + ((j + 1) % m);
      const c = start + j;
      const d = start + ((j + 1) % m);
      acc.indices.push(a, c, b, b, c, d);
    }
  }
  acc.lastRingStart = start;
}

function buildMesh(acc: MeshAccumulator): KnotMeshData {
  return {
    positions: new Float32Array(acc.positions),
    normals: new Float32Array(acc.normals),
    colors: new Float32Array(acc.colors),
    uvs: new Float32Array(acc.uvs),
    indices: new Uint32Array(acc.indices),
    vertexCount: acc.positions.length / 3,
    triangleCount: acc.indices.length / 3,
  };
}

// 低周波のムラ。seed で位相をずらした正弦3本の合成で 0〜1 を返す。
function wearNoise(seedPhase: number, s: number): number {
  return 0.5
    + 0.26 * Math.sin(2 * Math.PI * (3 * s) + seedPhase)
    + 0.16 * Math.sin(2 * Math.PI * (7 * s) + seedPhase * 1.7)
    + 0.08 * Math.sin(2 * Math.PI * (13 * s) + seedPhase * 2.3);
}

// 折れ線に沿って間隔 step ごとに球を置く(両端は必ず置く)。判定形状の組み立て。
function spheresAlongLine(line: readonly KnotPoint[], step: number): Vec3[] {
  const first = line[0];
  if (first === undefined) return [];
  const centers: Vec3[] = [[first[0], first[1], first[2]]];
  let cursor: Vec3 = [first[0], first[1], first[2]];
  let walked = 0;
  for (let i = 1; i < line.length; i += 1) {
    const vertex = line[i]!;
    let span = length(sub(vertex, cursor));
    while (walked + span >= step) {
      cursor = addScaled(cursor, sub(vertex, cursor), (step - walked) / span);
      centers.push(cursor);
      walked = 0;
      span = length(sub(vertex, cursor));
    }
    walked += span;
    cursor = [vertex[0], vertex[1], vertex[2]];
  }
  const end = line[line.length - 1]!;
  const last = centers[centers.length - 1]!;
  if (length(sub(last, end)) > 0) centers.push([end[0], end[1], end[2]]);
  return centers;
}

// 編みの索1本の中心線を、主中心線の稠密な元表とフレームから稠密に引く。索の
// 中心は主中心線のまわりを編み回転しながら進むため、主中心線の標本の間でも
// 速く折れ曲がる(編み位相と曲率が重なると、ほぼ同じ場所で折り返す)。主中心線と
// 同じ引き直し・細分を通せるよう、索も稠密な元表の形で返す。
function buildStrandDenseCurve(
  dense: DenseCurve,
  denseFrames: { normals: Vec3[]; binormals: Vec3[] },
  params: KnotParams,
  tubeRadius: number,
  strand: number,
): DenseCurve {
  const offset = tubeRadius * 0.95;
  const count = dense.points.length;
  const points: Vec3[] = [];
  for (let i = 0; i < count; i += 1) {
    const s = dense.closed ? i / count : (dense.keep * i) / (count - 1);
    const angle = 2 * Math.PI * (params.weaveTurns * s + strand / params.strands);
    points.push(addScaled(
      addScaled(dense.points[i]!, denseFrames.normals[i]!, Math.cos(angle) * offset),
      denseFrames.binormals[i]!, Math.sin(angle) * offset,
    ));
  }
  const cumulative = new Array<number>(count).fill(0);
  let total = 0;
  for (let i = 1; i < count; i += 1) {
    total += length(sub(points[i]!, points[i - 1]!));
    cumulative[i] = total;
  }
  if (dense.closed) total += length(sub(points[0]!, points[count - 1]!));
  return { points, taper: dense.taper, cumulative, totalLength: total, closed: dense.closed, keep: dense.keep };
}

// パラメーターから結節体1体の形を生成する。出現のときに1回だけ呼ぶ。同じ
// パラメーターからは常に同じ形が出る。
export function generateKnotShape(params: KnotParams): KnotShape {
  const p = normalizeKnotParams(params);
  const rand = rngOf(p.seed);
  const tubeRadius = p.mainRadius * p.tubeRatio;
  const dense = buildDenseCenterline(p);
  const main = sampleCenterline(dense, tubeRadius);
  const mainFrames = transportFrames(main.points, main.closed);

  // 索ごとの中心線標本とフレーム。1本なら中心線そのもの、複数なら編みの中心線を
  // 稠密に引いてから、主中心線と同じ引き直し・細分を通す — 索の折れ曲がりは
  // 索自身の標本で抑える。
  const strandSamples: CenterlineSamples[] = [];
  const strandFrames: { normals: Vec3[]; binormals: Vec3[] }[] = [];
  if (p.strands === 1) {
    strandSamples.push(main);
    strandFrames.push(mainFrames);
  } else {
    const denseFrames = transportFrames(dense.points, dense.closed);
    for (let strand = 0; strand < p.strands; strand += 1) {
      const samples = sampleCenterline(buildStrandDenseCurve(dense, denseFrames, p, tubeRadius, strand), tubeRadius);
      strandSamples.push(samples);
      strandFrames.push(transportFrames(samples.points, samples.closed));
    }
  }
  const strandCenters = strandSamples.map((samples) => samples.points);

  // 素線の露出パッチ(s の区間)。索ごとに開始をずらし、全索が同じ場所で光らないようにする。
  const patchCount = 2 + Math.floor(rand() * 3);
  const patches = Array.from({ length: patchCount }, () => {
    const start = rand() * 0.92;
    return { start, end: start + 0.02 + rand() * 0.045 };
  });
  const wearPhase = rand() * Math.PI * 2;

  const sheath = createMeshAccumulator();
  const bare = createMeshAccumulator();
  const strands: KnotStrandShape[] = [];
  for (let strand = 0; strand < p.strands; strand += 1) {
    const samples = strandSamples[strand]!;
    const centers = samples.points;
    const frames = strandFrames[strand]!;
    const strandCount = centers.length;
    const patchShift = strand * 0.37;
    // 位相は、その索の弧長割合へ元のパラメーター範囲(0〜keep)を写して揃える。
    const sAt = (i: number): number => (samples.arcs[i]! / samples.totalLength) * dense.keep;
    // 閉曲線では、最後にもう一周ぶん最初のリングを複製して繋ぎ、管を閉じる。
    const ringTotal = samples.closed ? strandCount + 1 : strandCount;
    let previousMaterial: 'sheath' | 'bare' | null = null;
    for (let i = 0; i < ringTotal; i += 1) {
      const ringIndex = samples.closed && i === strandCount ? 0 : i;
      const s = sAt(ringIndex);
      const bulge = 1 + p.bulgeAmp * Math.cos(2 * Math.PI * p.bulgeFreq * s + p.bulgePhase);
      const radius = tubeRadius * bulge * samples.taper[ringIndex]!;
      const shifted = (s + patchShift) % 1;
      const material = patches.some((patch) => shifted >= patch.start && shifted < patch.end) ? 'bare' : 'sheath';
      const acc = material === 'bare' ? bare : sheath;
      const wear = material === 'bare' ? 0.9 + 0.2 * wearNoise(wearPhase, s) : 0.64 + 0.72 * wearNoise(wearPhase, s);
      // 交点付近(膨らみの山)は擦れて明るくなる。
      const sheen = 1 + 0.35 * (bulge - 1);
      const base = material === 'bare' ? BARE_BASE_COLOR : SHEATH_BASE_COLOR;
      const ring: { position: Vec3; normal: Vec3; color: Vec3; u: number; v: number }[] = [];
      for (let j = 0; j < RADIAL_SEGMENTS; j += 1) {
        const a = (2 * Math.PI * j) / RADIAL_SEGMENTS;
        const dir = addScaled(
          addScaled([0, 0, 0], frames.normals[ringIndex]!, Math.cos(a)),
          frames.binormals[ringIndex]!, Math.sin(a),
        );
        // 撚りの縞: 断面の角と長さ方向の進行を合わせた螺旋位相で明暗を付ける。
        const spiral = 0.5 + 0.5 * Math.cos(2 * Math.PI * (j / RADIAL_SEGMENTS + TWIST_TURNS * s));
        const stripe = material === 'bare' ? 0.78 + 0.44 * spiral : 0.9 + 0.2 * spiral;
        const shade = wear * sheen * stripe;
        ring.push({
          position: addScaled(centers[ringIndex]!, dir, radius),
          normal: dir,
          color: [base[0] * shade, base[1] * shade, base[2] * shade],
          u: s * 40,
          v: j / RADIAL_SEGMENTS,
        });
      }
      addRing(acc, ring, previousMaterial === material);
      previousMaterial = material;
    }
    strands.push({
      centerline: centers, normals: frames.normals, binormals: frames.binormals,
      closed: samples.closed, tubeRadius,
    });
  }

  // 判定球とセグメント。索ごとに中心線を覆う球を並べ、連続した球の並びを
  // セグメントへ区切る。
  const sphereRadius = tubeRadius * (1 + p.bulgeAmp);
  const spheres: KnotSphere[] = [];
  const segments: KnotSegmentShape[] = [];
  for (let strand = 0; strand < p.strands; strand += 1) {
    const centers = spheresAlongLine(strandCenters[strand]!, sphereRadius * SPHERE_SPACING_RATIO);
    for (let start = 0; start < centers.length; start += KNOT_SEGMENT_SPHERES) {
      const chunk = centers.slice(start, start + KNOT_SEGMENT_SPHERES);
      const segmentIndex = segments.length;
      const sphereStart = spheres.length;
      for (const center of chunk) spheres.push({ center, radius: sphereRadius, segment: segmentIndex });
      segments.push({
        index: segmentIndex,
        strand,
        sphereStart,
        sphereCount: chunk.length,
        midpoint: chunk[Math.floor(chunk.length / 2)]!,
      });
    }
  }

  // 結節ノードは索へ均等に配し、役割は3役を順に回して割り当てる(種で開始を
  // ずらす)。3個以上あれば全役が少なくとも1つは付く。
  const roleOrder: readonly KnotNodeRole[] = ['shooter', 'sensor', 'drive'];
  const roleShift = Math.floor(rand() * 3);
  const nodes: KnotNodeShape[] = [];
  {
    let assigned = 0;
    for (let strand = 0; strand < p.strands; strand += 1) {
      const forStrand = Math.floor(p.nodeCount / p.strands) + (strand < p.nodeCount % p.strands ? 1 : 0);
      const strandPointCount = strandCenters[strand]!.length;
      for (let j = 0; j < forStrand; j += 1) {
        const index = Math.min(strandPointCount - 1, Math.floor(((j + 0.5) / forStrand) * strandPointCount));
        nodes.push({
          index: nodes.length,
          role: roleOrder[(roleShift + assigned) % 3]!,
          position: strandCenters[strand]![index]!,
          radius: tubeRadius * NODE_RADIUS_RATIO * (0.9 + 0.2 * rand()),
          strand,
        });
        assigned += 1;
      }
    }
  }

  // 駆動中核は全索の中心線の重心に置く。
  const centroid: Vec3 = [0, 0, 0];
  let centroidCount = 0;
  for (const centers of strandCenters) {
    for (const point of centers) {
      centroid[0] += point[0]; centroid[1] += point[1]; centroid[2] += point[2];
      centroidCount += 1;
    }
  }
  centroid[0] /= centroidCount; centroid[1] /= centroidCount; centroid[2] /= centroidCount;
  const core: KnotCoreShape = { position: centroid, radius: tubeRadius * CORE_RADIUS_RATIO };

  // デブリ片は、ほつれ度が高い古い個体ほど多い。
  const debris: KnotDebrisPlacement[] = [];
  const debrisCount = Math.round(p.fray * 7);
  for (let i = 0; i < debrisCount; i += 1) {
    const index = Math.floor(rand() * main.points.length);
    const point = main.points[index]!;
    const outward = addScaled(
      addScaled([0, 0, 0], mainFrames.normals[index]!, rand() * 2 - 1),
      mainFrames.binormals[index]!, rand() * 2 - 1,
    );
    const position = addScaled(point, normalize(outward), tubeRadius * (1.2 + rand() * 0.9));
    debris.push({
      position: [position[0], position[1], position[2]],
      rotation: [rand() * Math.PI, rand() * Math.PI, rand() * Math.PI],
      size: [
        p.mainRadius * (0.05 + rand() * 0.08),
        p.mainRadius * (0.03 + rand() * 0.05),
        p.mainRadius * 0.008,
      ],
    });
  }

  // 慣性は、索の中心線を質量 len × 半径² の点列とみなした対角近似(最大で正規化)。
  let ixx = 0;
  let iyy = 0;
  let izz = 0;
  for (const strand of strands) {
    const line = strand.centerline;
    const span = strand.closed ? line.length : line.length - 1;
    for (let i = 0; i < span; i += 1) {
      const a = line[i]!;
      const b = line[(i + 1) % line.length]!;
      const mass = length(sub(b, a)) * tubeRadius * tubeRadius;
      const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      ixx += mass * (mid[1] * mid[1] + mid[2] * mid[2]);
      iyy += mass * (mid[0] * mid[0] + mid[2] * mid[2]);
      izz += mass * (mid[0] * mid[0] + mid[1] * mid[1]);
    }
  }
  const inertiaMax = Math.max(ixx, iyy, izz);
  const inertia: KnotPoint = inertiaMax > 0
    ? [ixx / inertiaMax, iyy / inertiaMax, izz / inertiaMax]
    : [1, 1, 1];

  let outerRadius = 0;
  for (const strand of strands) {
    for (const point of strand.centerline) {
      outerRadius = Math.max(outerRadius, length(point) + tubeRadius);
    }
  }
  for (const node of nodes) outerRadius = Math.max(outerRadius, length(node.position) + node.radius);
  outerRadius = Math.max(outerRadius, length(core.position) + core.radius);

  const sheathData = buildMesh(sheath);
  const bareData = buildMesh(bare);
  return {
    params: p,
    strands,
    sheath: sheathData,
    bare: bareData,
    spheres,
    segments,
    nodes,
    core,
    debris,
    vertexCount: sheathData.vertexCount + bareData.vertexCount,
    triangleCount: sheathData.triangleCount + bareData.triangleCount,
    outerRadius,
    inertia,
  };
}
