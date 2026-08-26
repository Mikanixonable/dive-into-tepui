// THREE で曲線を折れ線で最適に近似して描く。
//
// setAnalyticCurve: 曲線の解析的な式を直接受け取り、曲線として描く。
// setHermiteCurve: 節点列を受け取り、節点間を3次エルミートで埋めた滑らかな曲線として描く。
//
// いずれの用途でも、頂点を t のどこに何個置くかは画面上のサジッタと折れ角を見て決め、
// ズーム・視線の変化に応じて焼き直す。

import * as THREE from 'three/webgpu';
import { MaxHeap } from '../physics/max-heap';
import { CameraScale } from './camera-scale';
import type { LineStyle } from './line-style';
import { markOverlay } from './pipeline/lit-layer';

export type CurveOptions = {
  readonly style: LineStyle;
  // 適応分割が収束しない可能性がある時に、最悪描画コストの打ち切りとして渡す
  readonly maxVertices?: number;
  // 弦に対する曲線の膨らみ(サジッタ)の目標値 [px]。線の品質を調整する入口。
  // 小さくすれば頂点を増やして曲線へ寄せ、大きくすれば粗く済ませる。
  readonly maxSagittaPx?: number;
  // 1辺あたりに許す折れ角の上限 [deg]。サジッタと並ぶもう一つの品質の入口で、こちらは画面上の
  // 大きさに依らず効くため、遠ズームでの粗さを決める。
  readonly maxEdgeTurnDeg?: number;
};

// t∈[0,1] における曲線上の点を out へ書く。sample(0) と sample(1) が一致するなら、その曲線は
// 閉じた輪として描かれる。
export type CurveSampler = (t: number, out: THREE.Vector3) => void;

// t∈[0,1] における頂点色を out へ書く。頂点が確定したあとに、その t で1回だけ呼ばれる。
// 書いた色はマテリアル色に乗算される。
export type CurveColorSampler = (t: number, out: THREE.Color) => void;

export type SetCurveOptions = {
  // 曲線の中身が変わったことを表す不透明な値。前回と === で異なるときだけ焼き直す。
  readonly revision: unknown;
  // 画面上の目標を実距離へ換算するための、現在の描画カメラ。
  readonly camera: THREE.Camera;
  // 適応分割を始める区間数(setAnalyticCurve のみ)。適応分割は弦の中点しか見ないので、
  // 1区間に何周ぶんも入る曲線では中点がたまたま曲線上に乗り、区間まるごとが直線に化ける。
  // 「1区間が曲線の半周を超えない」下限を渡してそれを防ぐ。
  readonly initialSegments?: number;
  // 線の中で色が変わるときだけ渡す。省略すれば setStyle/setColor の単色で塗られる。
  readonly colorAt?: CurveColorSampler;
};

// サジッタ目標の既定値 [px]。1px を下回っていれば、隣り合う画素の間に収まる。
const DEFAULT_MAX_SAGITTA_PX = 0.5;

// 折れ角上限の既定値 [deg]。
const DEFAULT_MAX_EDGE_TURN_DEG = 5;

// initialSegments を省いたときの初期分割数。閉曲線を1区間のまま評価すると t=0/1 が同一点で
// 弦が縮退するため、最低限これだけ分けてから適応分割に入る。
const INITIAL_SEGMENTS = 8;

// 頂点予算のうち初期頂点へ回してよい割合。残りを適応分割が逸脱の大きい区間へ配るので、
// 少し余らせたほうが細部の要る場所に頂点が集まる。
const MAX_INITIAL_VERTEX_RATIO = 0.5;

// 頂点数の既定の上限 [頂点]。1周ぶんの閉曲線はサジッタ目標を満たして 360 頂点ほどで自ら
// 収束するので、それに余裕を足した値を採る。
const DEFAULT_MAX_VERTICES = 512;

const uniformTsCache = new Map<number, readonly number[]>();

// t を segments 等分した昇順の列(両端を含む)。区間数ごとに1回だけ作って使い回す。
function uniformTs(segments: number): readonly number[] {
  const cached = uniformTsCache.get(segments);
  if (cached) return cached;
  const ts = Array.from({ length: segments + 1 }, (_, i) => i / segments);
  uniformTsCache.set(segments, ts);
  return ts;
}

// 代表スケールを測るために曲線上から等間隔に抜く点数。
const SCALE_PROBE_POINTS = 8;

// 1区間に許す t 幅の下限。同じ点を返し続ける sample では逸脱が分割しても下がらないので、
// その区間へ頂点予算を吸わせないための安全弁。
const MIN_T_SPAN = 2 ** -24;

// 焼き直しを起こす画面スケールの変化比。毎フレームの微小なズーム変化で焼き直さないための遊び。
const SCALE_REBAKE_RATIO = 1.2;

// f32 の相対量子化幅(仮数23bit)。sample の座標系は LEO スケールの絶対座標を含みうるので、
// そのまま頂点バッファ(f32)へ書くと座標の大きさに応じた量子化ノイズが画面上のずれとして
// 見えてしまう。頂点バッファへはカメラ近傍の基準点(pivot)からの差分だけを書いてこれを防ぐ。
const F32_RELATIVE_EPS = 2 ** -24;

// pivot の更新を許す画面上の誤差上限を、サジッタ目標に対する比で表した値。量子化誤差が
// 分割の粗さに埋もれて見えなくなるよう、目標より十分小さく取る。
const PIVOT_MAX_ERROR_RATIO = 0.2;

// 離散サンプルとしてしか手に入らない曲線の節点列。ts は節点の曲線パラメータ(昇順、先頭 0・
// 末尾 1)、positions と tangents は各節点の位置と d(位置)/d(パラメータ) を [x, y, z] の順に
// 並べた長さ ts.length * 3 の列。
export type CurveKnots = {
  readonly ts: readonly number[];
  readonly positions: readonly number[];
  readonly tangents: readonly number[];
};

// 節点列から組んだ曲線。ts は節点自身のパラメータ列で、そのまま初期頂点の位置になる。
type HermiteCurve = { readonly sample: CurveSampler; readonly ts: ArrayLike<number> };

// 節点間を3次エルミート(両端の位置を通り、両端の接線を持つ)で埋めた曲線を組む。節点が
// maxCount 個を超えるぶんは元の並びの上で等間隔に間引く(両端は残すので定義域は縮まない)。
function buildHermiteCurve(knots: CurveKnots, maxCount: number): HermiteCurve {
  const source = knots.ts;
  if (source.length < 2) throw new Error(`Curve: 節点が ${source.length} 個では曲線にならない`);
  const last = source.length - 1;
  const count = Math.min(source.length, maxCount);
  const ts = new Float64Array(count);
  const positions = new Float64Array(count * 3);
  const tangents = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const j = count === source.length ? i : Math.round((i * last) / (count - 1));
    ts[i] = source[j]!;
    if (i > 0 && ts[i]! <= ts[i - 1]!) throw new Error(`Curve: 節点のパラメータが昇順でない (i=${j})`);
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = knots.positions[j * 3 + k]!;
      tangents[i * 3 + k] = knots.tangents[j * 3 + k]!;
    }
  }

  const sample: CurveSampler = (t, out) => {
    // t を含む区間 [i, i+1] を二分探索で引く。両端の外は端の区間へ寄せる。
    let lo = 0, hi = count - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid]! <= t) lo = mid; else hi = mid - 1;
    }
    const h = ts[lo + 1]! - ts[lo]!;
    const s = Math.max(0, Math.min(1, (t - ts[lo]!) / h));
    const s2 = s * s, s3 = s2 * s;
    const w0 = 2 * s3 - 3 * s2 + 1, w1 = (s3 - 2 * s2 + s) * h;
    const w2 = -2 * s3 + 3 * s2, w3 = (s3 - s2) * h;
    const a = lo * 3, b = a + 3;
    out.set(
      w0 * positions[a]! + w1 * tangents[a]! + w2 * positions[b]! + w3 * tangents[b]!,
      w0 * positions[a + 1]! + w1 * tangents[a + 1]! + w2 * positions[b + 1]! + w3 * tangents[b + 1]!,
      w0 * positions[a + 2]! + w1 * tangents[a + 2]! + w2 * positions[b + 2]! + w3 * tangents[b + 2]!,
    );
  };
  return { sample, ts };
}

// 点 p から線分 ab への最短距離の2乗。
function distanceSqPointToSegment(
  px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number,
): number {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const lenSq = dx * dx + dy * dy + dz * dz;
  if (lenSq <= 0) {
    const ex = px - ax, ey = py - ay, ez = pz - az;
    return ex * ex + ey * ey + ez * ez;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / lenSq));
  const cx = ax + dx * t, cy = ay + dy * t, cz = az + dz * t;
  const ex = px - cx, ey = py - cy, ez = pz - cz;
  return ex * ex + ey * ey + ez * ez;
}

export class Curve {
  readonly object: THREE.Object3D;
  private readonly line: THREE.LineSegments;
  private readonly geom: THREE.BufferGeometry;
  private readonly mat: THREE.Material;
  private readonly positions: Float32Array;
  private readonly indices: Uint32Array;
  private readonly maxVertices: number;
  private readonly maxSegments: number;
  private readonly lineDistances: Float32Array | null;
  private vertexCount = 0;
  private wantVisible = true;

  // 直近に setStyle で反映済みの見た目。個別 setter を経由すると null に戻し、
  // 次の setStyle が確実に書き直すようにする。
  private appliedStyle: LineStyle | null = null;

  // 適応分割で焼いた頂点(sample の座標系のまま)。GPU へ渡す positions(f32)は常にこの配列
  // から pivot を差し引いて書くので、pivot 自体の精度を落とさないよう倍精度で持つ。
  private readonly bakedLocal: Float64Array;
  // 頂点ごとの色(colorAt が指定されたときだけ埋める)。位置と同じ生成順。
  private readonly bakedColor: Float32Array;
  private hasVertexColors = false;
  // 各頂点の曲線上の位置 t。位置と同じ生成順。
  private readonly ts: Float64Array;
  // 焼いた頂点を t 昇順に繋ぐ連結リスト(終端は -1)。頂点は生成順に置いたまま動かさないので、
  // 描画順はこれを辿って書くインデックスバッファが担う。
  private readonly nextVertex: Int32Array;
  private bakedCount = 0;
  // 直近に渡された曲線。sampleAt が読む。
  private sampler: CurveSampler | null = null;
  // 直近に setHermiteCurve が受け取った節点列と、そこから組んだ曲線。節点列が同じ間は
  // 組み直さない。
  private hermiteKnots: CurveKnots | null = null;
  private hermite: HermiteCurve | null = null;
  private hasBaked = false;
  private lastRevision: unknown = undefined;
  private bakedScale: number | null = null;
  private readonly bakedCamFwd = new THREE.Vector3();

  // 頂点バッファ(f32)へ書く直前に bakedLocal の全頂点から差し引く基準点。sample の座標系の
  // まま、カメラの現在位置に追従させる。
  private readonly pivot = new THREE.Vector3();
  private hasPivot = false;

  // setTransform が要求した sample→ワールドの変換。line.position/quaternion へはこれに pivot
  // 分を補って書き込むので、sample の座標系を扱う計算はこちらを読む。
  private readonly reqPosition = new THREE.Vector3();
  private readonly reqQuaternion = new THREE.Quaternion();

  private readonly scratchA = new THREE.Vector3();
  private readonly scratchM = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();
  private readonly scratchStyleColor = new THREE.Color();
  private readonly scratchWorld = new THREE.Vector3();
  private readonly scratchLocalCam = new THREE.Vector3();
  private readonly scratchInvQuat = new THREE.Quaternion();
  private readonly scratchPivotWorld = new THREE.Vector3();


  // 未分割の区間を逸脱の大きい順に取り出す待ち行列。区間はその左端の頂点番号で表し、
  // 右端は nextVertex から辿る。
  private readonly pending: MaxHeap;

  // 初期頂点に置ける頂点数の上限。
  private readonly maxInitialVertices: number;

  // 分割をどこで止めるかを決める2つの目標。画面上のサジッタ [px] と1辺の折れ角 [rad]。
  private readonly maxSagittaPx: number;
  private readonly maxEdgeTurn: number;
  // 焼き直しを起こす視線方向の変化(なす角の余弦)。適応分割は焼いた瞬間の視線を基準に
  // 手前だけ細かく焼くため、向きだけ変わっても粗い区間が手前へ回り込む。それが折れ角の
  // 上限を超えて見えない角度で焼き直す。
  private readonly camDirRebakeCos: number;

  // 頂点バッファは maxVertices ぶんを生成時に1回だけ確保する。style.dash があれば破線になる。
  constructor(opts: CurveOptions) {
    const {
      style, maxVertices = DEFAULT_MAX_VERTICES, maxSagittaPx = DEFAULT_MAX_SAGITTA_PX,
      maxEdgeTurnDeg = DEFAULT_MAX_EDGE_TURN_DEG,
    } = opts;
    this.maxSagittaPx = maxSagittaPx;
    this.maxEdgeTurn = (maxEdgeTurnDeg * Math.PI) / 180;
    this.camDirRebakeCos = Math.cos(this.maxEdgeTurn);
    const { color, opacity, renderOrder, dash } = style;
    this.maxVertices = maxVertices;
    this.maxInitialVertices = Math.max(INITIAL_SEGMENTS + 1, Math.floor(maxVertices * MAX_INITIAL_VERTEX_RATIO));
    this.maxSegments = Math.max(0, maxVertices - 1);
    this.positions = new Float32Array(maxVertices * 3);
    this.bakedLocal = new Float64Array(maxVertices * 3);
    this.bakedColor = new Float32Array(maxVertices * 3);
    this.ts = new Float64Array(maxVertices);
    this.nextVertex = new Int32Array(maxVertices);
    this.pending = new MaxHeap(maxVertices);
    this.indices = new Uint32Array(this.maxSegments * 2);
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    // 色属性は使う前から束縛しておく。後から属性を足すと、束縛済みのジオメトリに対する
    // 差し替えになって新しいバッファが描画へ反映されない。
    this.geom.setAttribute('color', new THREE.BufferAttribute(this.bakedColor, 3));
    this.geom.setIndex(new THREE.BufferAttribute(this.indices, 1));
    this.geom.setDrawRange(0, 0);

    if (dash) {
      this.lineDistances = new Float32Array(maxVertices);
      this.geom.setAttribute('lineDistance', new THREE.BufferAttribute(this.lineDistances, 1));
    } else {
      this.lineDistances = null;
    }

    this.mat = dash
      ? new THREE.LineDashedMaterial({
        color, transparent: true, opacity, depthWrite: false,
        dashSize: dash.dashSize, gapSize: dash.gapSize,
      })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });

    this.line = new THREE.LineSegments(this.geom, this.mat);
    // 折れ線は表示値であって物理的な明るさを持たないので、3D UI パスへ置く。
    markOverlay(this.line);
    this.line.renderOrder = renderOrder;
    this.line.visible = false;
    // 頂点はバッファへ書き込むだけで外接球を更新しないので、既定のフラスタム判定は
    // 初期値(全頂点ゼロ)の外接球で切ってしまう。
    this.line.frustumCulled = false;
    this.object = this.line;
    this.appliedStyle = style;
  }

  // sample の座標系の点における m/px。要求された変換でワールドへ写してから換算する — pivot は
  // カメラの動きに追従するだけの GPU バッファ上の便宜なので、ここでは読まない。
  private scaleAtLocal(cam: CameraScale, lx: number, ly: number, lz: number): number {
    this.scratchWorld.set(lx, ly, lz).applyQuaternion(this.reqQuaternion).add(this.reqPosition);
    return cam.at(this.scratchWorld.x, this.scratchWorld.y, this.scratchWorld.z);
  }

  // 曲線を代表する m/px。分割の粗さを決めるのは最もカメラに寄っている点なので、曲線上から
  // 抜いた数点の最小値を採る(1点だけ見ると、その点が視点面をまたぐ曲線で値が乱高下して
  // 毎フレーム焼き直しになる)。
  private representativeScale(sample: CurveSampler, ts: ArrayLike<number>, cam: CameraScale): number {
    let minScale = Infinity;
    const last = ts.length - 1;
    for (let i = 0; i <= SCALE_PROBE_POINTS; i++) {
      sample(ts[Math.round((i * last) / SCALE_PROBE_POINTS)]!, this.scratchA);
      const s = this.scaleAtLocal(cam, this.scratchA.x, this.scratchA.y, this.scratchA.z);
      if (s < minScale) minScale = s;
    }
    return minScale;
  }

  // カメラのワールド位置を sample の座標系へ戻す。
  private localCameraPos(cam: CameraScale, out: THREE.Vector3): THREE.Vector3 {
    this.scratchInvQuat.copy(this.reqQuaternion).invert();
    return out.copy(cam.position).sub(this.reqPosition).applyQuaternion(this.scratchInvQuat);
  }

  // 要求された変換と現在の pivot から、line の実際の position/quaternion を書き直す。
  private applyTransform(): void {
    this.line.quaternion.copy(this.reqQuaternion);
    this.scratchPivotWorld.copy(this.pivot).applyQuaternion(this.reqQuaternion);
    this.line.position.copy(this.reqPosition).add(this.scratchPivotWorld);
  }

  // 位置 t の頂点を積み、その番号を返す。連結リストへの接続は呼び出し側が行う。
  private pushVertex(t: number, x: number, y: number, z: number, colorAt?: CurveColorSampler): number {
    const i = this.bakedCount++;
    this.ts[i] = t;
    const o = i * 3;
    this.bakedLocal[o] = x;
    this.bakedLocal[o + 1] = y;
    this.bakedLocal[o + 2] = z;
    if (colorAt) this.bakeColor(i, t, colorAt);
    return i;
  }

  // 頂点 i の色を、その t で colorAt を評価して色バッファへ書く。
  private bakeColor(i: number, t: number, colorAt: CurveColorSampler): void {
    colorAt(t, this.scratchColor);
    const o = i * 3;
    this.bakedColor[o] = this.scratchColor.r;
    this.bakedColor[o + 1] = this.scratchColor.g;
    this.bakedColor[o + 2] = this.scratchColor.b;
  }

  // 左端が頂点 seg の区間を弦で代用したときの逸脱。サジッタと折れ角をそれぞれ目標との比に
  // して大きい方を採るので、単位の違う2つの基準が1つの順序に乗り、1 を超える区間が分割に値する。
  private segmentError(seg: number, sample: CurveSampler, cam: CameraScale): number {
    const right = this.nextVertex[seg]!;
    const t0 = this.ts[seg]!, t1 = this.ts[right]!;
    if (t1 - t0 <= MIN_T_SPAN) return 0;

    const a = seg * 3, b = right * 3;
    const x0 = this.bakedLocal[a]!, y0 = this.bakedLocal[a + 1]!, z0 = this.bakedLocal[a + 2]!;
    const x1 = this.bakedLocal[b]!, y1 = this.bakedLocal[b + 1]!, z1 = this.bakedLocal[b + 2]!;
    sample((t0 + t1) / 2, this.scratchM);
    const mx = this.scratchM.x, my = this.scratchM.y, mz = this.scratchM.z;

    const sagSq = distanceSqPointToSegment(mx, my, mz, x0, y0, z0, x1, y1, z1);
    const mpp = this.scaleAtLocal(cam, mx, my, mz);
    const sagittaPx = mpp > 0 ? Math.sqrt(sagSq) / mpp : 0;

    const ax = mx - x0, ay = my - y0, az = mz - z0;
    const bx = x1 - mx, by = y1 - my, bz = z1 - mz;
    const aLen = Math.hypot(ax, ay, az), bLen = Math.hypot(bx, by, bz);
    const turn = aLen > 0 && bLen > 0
      ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (aLen * bLen))))
      : 0;

    return Math.max(sagittaPx / this.maxSagittaPx, turn / this.maxEdgeTurn);
  }

  // 初期頂点列から始めて、逸脱が最大の区間から順に二分していく。予算が尽きて打ち切っても残りの
  // 区間の逸脱は最後に分割した区間以下なので、劣化は曲線全体が一様に粗くなる方向へ向かう。
  private rebake(sample: CurveSampler, ts: ArrayLike<number>, cam: CameraScale, colorAt?: CurveColorSampler): void {
    this.bakedCount = 0;
    this.pending.clear();
    const segmentCount = ts.length - 1;
    for (let i = 0; i <= segmentCount; i++) {
      const t = ts[i]!;
      sample(t, this.scratchA);
      this.pushVertex(t, this.scratchA.x, this.scratchA.y, this.scratchA.z, colorAt);
      this.nextVertex[i] = i < segmentCount ? i + 1 : -1;
    }
    for (let i = 0; i < segmentCount; i++) this.pending.push(this.segmentError(i, sample, cam), i);

    while (this.pending.topScore > 1 && this.bakedCount < this.maxVertices) {
      const left = this.pending.pop();
      const right = this.nextVertex[left]!;
      const tm = (this.ts[left]! + this.ts[right]!) / 2;
      sample(tm, this.scratchM);
      const mid = this.pushVertex(tm, this.scratchM.x, this.scratchM.y, this.scratchM.z, colorAt);
      this.nextVertex[mid] = right;
      this.nextVertex[left] = mid;
      this.pending.push(this.segmentError(left, sample, cam), left);
      this.pending.push(this.segmentError(mid, sample, cam), mid);
    }
  }

  // 閉じた式で書ける曲線を描く。sample は t∈[0,1] で曲線上の点を返す滑らかな関数。
  setAnalyticCurve(sample: CurveSampler, opts: SetCurveOptions): void {
    const requested = Math.max(INITIAL_SEGMENTS, opts.initialSegments ?? 0);
    this.setCurve(sample, uniformTs(Math.min(requested, this.maxInitialVertices - 1)), opts);
  }

  // 離散サンプルとしてしか手に入らない曲線を、節点間を3次エルミートで埋めて描く。節点は
  // そのまま初期頂点になる。
  setHermiteCurve(knots: CurveKnots, opts: SetCurveOptions): void {
    let hermite = this.hermite;
    if (hermite === null || knots !== this.hermiteKnots) {
      hermite = buildHermiteCurve(knots, this.maxInitialVertices);
      this.hermite = hermite;
      this.hermiteKnots = knots;
    }
    this.setCurve(hermite.sample, hermite.ts, opts);
  }

  // いま描いている曲線を t∈[0,1] で評価する。曲線をまだ渡されていなければ原点を返す。
  sampleAt(t: number, out: THREE.Vector3): void {
    if (this.sampler) this.sampler(t, out);
    else out.set(0, 0, 0);
  }

  // 曲線を(必要なら)焼き直し、GPU バッファへ反映する。revision・画面スケール・視線方向の
  // いずれも前回と実質同じなら、焼き直しも再アップロードも省く。
  private setCurve(sample: CurveSampler, ts: ArrayLike<number>, opts: SetCurveOptions): void {
    const { revision, camera, colorAt } = opts;
    this.sampler = sample;
    const cam = new CameraScale(camera);
    const scaleNow = this.representativeScale(sample, ts, cam);
    const scaleChanged = this.bakedScale === null
      || scaleNow / this.bakedScale > SCALE_REBAKE_RATIO || this.bakedScale / scaleNow > SCALE_REBAKE_RATIO;
    const camDirChanged = cam.forward.dot(this.bakedCamFwd) < this.camDirRebakeCos;
    // 色を後から使い始めたときは、焼いてある頂点に色が入っていないので必ず焼き直す
    // (そうしないと色属性が 0 のまま束縛されて線が黒くなる)。使うのをやめたときは、
    // 焼いてある色がマテリアル色に掛かり続けないよう頂点カラーを外す。
    const wantsVertexColors = colorAt !== undefined;
    const colorsTurnedOn = wantsVertexColors && !this.hasVertexColors;
    if (wantsVertexColors !== this.hasVertexColors) this.useVertexColors(wantsVertexColors);

    const revisionChanged = !this.hasBaked || revision !== this.lastRevision;
    const rebaked = revisionChanged || scaleChanged || camDirChanged || colorsTurnedOn;

    if (rebaked) {
      this.rebake(sample, ts, cam, colorAt);
      this.hasBaked = true;
      this.lastRevision = revision;
      this.bakedScale = scaleNow;
      this.bakedCamFwd.copy(cam.forward);
    }

    // pivot はカメラ近傍に据え続ける。焼き直した直後は必ず、それ以外はカメラが pivot から
    // 離れて量子化誤差が画面上で無視できなくなったときだけ据え直す。
    const localCam = this.localCameraPos(cam, this.scratchLocalCam);
    let pivotChanged = rebaked || !this.hasPivot;
    if (!pivotChanged) {
      const drift = localCam.distanceTo(this.pivot);
      pivotChanged = (drift * F32_RELATIVE_EPS) / scaleNow > this.maxSagittaPx * PIVOT_MAX_ERROR_RATIO;
    }
    if (pivotChanged) {
      this.pivot.copy(localCam);
      this.hasPivot = true;
      this.applyTransform();
    }

    if (!rebaked && !pivotChanged) return;
    this.writePositions();
  }

  // マテリアルが頂点カラーを乗算するかどうかを切り替える。
  private useVertexColors(enabled: boolean): void {
    this.hasVertexColors = enabled;
    (this.mat as THREE.LineBasicMaterial | THREE.LineDashedMaterial).vertexColors = enabled;
    this.mat.needsUpdate = true;
  }

  // 焼いてある頂点の色だけを colorAt で評価し直して GPU へ送る。まだ一度も焼いていなければ
  // 何もしない。
  setColors(colorAt: CurveColorSampler): void {
    if (!this.hasBaked) return;
    if (!this.hasVertexColors) this.useVertexColors(true);
    for (let i = 0; i < this.bakedCount; i++) this.bakeColor(i, this.ts[i]!, colorAt);
    (this.geom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  // 焼いた頂点(pivot 差し引き後)と描画範囲を GPU へ反映する。
  private writePositions(): void {
    const n = this.bakedCount;
    const { x: px, y: py, z: pz } = this.pivot;
    for (let i = 0; i < n; i++) {
      this.positions[i * 3] = this.bakedLocal[i * 3]! - px;
      this.positions[i * 3 + 1] = this.bakedLocal[i * 3 + 1]! - py;
      this.positions[i * 3 + 2] = this.bakedLocal[i * 3 + 2]! - pz;
    }
    this.vertexCount = n;
    (this.geom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    if (this.hasVertexColors) (this.geom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    const segments = this.writeSegments();
    (this.geom.getIndex() as THREE.BufferAttribute).needsUpdate = true;
    this.geom.setDrawRange(0, segments * 2);
    this.applyVisible();
  }

  // 連結リストを辿って線分のインデックス対を書き、その本数を返す(破線なら始点からの累積距離も
  // 同じ走査で書く)。
  private writeSegments(): number {
    let count = 0;
    let dist = 0;
    for (let v = 0; ;) {
      if (this.lineDistances) this.lineDistances[v] = dist;
      const w = this.nextVertex[v]!;
      if (w < 0) break;
      this.indices[count * 2] = v;
      this.indices[count * 2 + 1] = w;
      count++;
      if (this.lineDistances) {
        const a = v * 3, b = w * 3;
        dist += Math.hypot(
          this.bakedLocal[b]! - this.bakedLocal[a]!,
          this.bakedLocal[b + 1]! - this.bakedLocal[a + 1]!,
          this.bakedLocal[b + 2]! - this.bakedLocal[a + 2]!,
        );
      }
      v = w;
    }
    if (this.lineDistances) {
      (this.geom.getAttribute('lineDistance') as THREE.BufferAttribute).needsUpdate = true;
    }
    return count;
  }

  // 曲線を持たない状態へ戻す。表示要求に関わらず何も描かれなくなる。
  clear(): void {
    this.bakedCount = 0;
    this.sampler = null;
    this.hermiteKnots = null;
    this.hermite = null;
    this.vertexCount = 0;
    this.hasBaked = false;
    this.bakedScale = null;
    this.lastRevision = undefined;
    this.geom.setDrawRange(0, 0);
    this.applyVisible();
  }

  // 破線パターンを書き換える。破線でないマテリアルでは何もしない。
  setDash(dashSize: number, gapSize: number): void {
    if (this.mat instanceof THREE.LineDashedMaterial) {
      this.mat.dashSize = dashSize;
      this.mat.gapSize = gapSize;
    }
    this.appliedStyle = null;
  }

  // マテリアルの不透明度を書き換える。
  setOpacity(opacity: number): void {
    this.mat.opacity = opacity;
    this.appliedStyle = null;
  }

  // マテリアルを作り直さず色だけ更新する。既に同じ色なら何もしない。
  setColor(color: THREE.ColorRepresentation): void {
    const material = this.mat as THREE.LineBasicMaterial | THREE.LineDashedMaterial;
    this.scratchStyleColor.set(color);
    if (material.color.equals(this.scratchStyleColor)) return;
    material.color.copy(this.scratchStyleColor);
    material.needsUpdate = true;
    this.appliedStyle = null;
  }

  setRenderOrder(renderOrder: number): void {
    this.line.renderOrder = renderOrder;
    this.appliedStyle = null;
  }

  // 見た目をまとめて書き換える。適用済みの値と一致するなら何もしない。
  setStyle(style: LineStyle): void {
    const applied = this.appliedStyle;
    if (applied
      && applied.color === style.color
      && applied.opacity === style.opacity
      && applied.renderOrder === style.renderOrder
      && applied.dash?.dashSize === style.dash?.dashSize
      && applied.dash?.gapSize === style.dash?.gapSize) {
      return;
    }
    this.setColor(style.color);
    this.setOpacity(style.opacity);
    this.setRenderOrder(style.renderOrder);
    if (style.dash) this.setDash(style.dash.dashSize, style.dash.gapSize);
    this.appliedStyle = style;
  }

  // sample の座標系をワールドへ写す変換を渡す。
  setTransform(position: THREE.Vector3, quaternion?: THREE.Quaternion): void {
    this.reqPosition.copy(position);
    if (quaternion) this.reqQuaternion.copy(quaternion);
    else this.reqQuaternion.identity();
    this.applyTransform();
  }

  // 表示を要求する。頂点数が2未満の間は隠れたままになる。
  setVisible(v: boolean): void {
    this.wantVisible = v;
    this.applyVisible();
  }

  // 折れ線は2点以上ないと描けないので、頂点数が足りるまでは表示要求を保留する。
  private applyVisible(): void {
    this.line.visible = this.wantVisible && this.vertexCount >= 2;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
