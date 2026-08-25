// THREE で折れ線(曲線)を描く機構だけを担う。頂点をどこに置くかは t∈[0,1] を評価する
// sample 関数から画面上のサジッタ・折れ角を見て自前で決める(適応分割) — 呼び出し側は
// 「t を渡すと曲線上の点が返る」関数(と、細部の位置を知っているならその t の列)だけを
// 渡せばよく、それが楕円かエルミート補間かは知らない。座標変換前の値も座標型
// (Vec3/KinematicState/…)も知らず、受け取るのは THREE.Vector3/THREE.Camera と数値だけ。
import * as THREE from 'three/webgpu';
import { MaxHeap } from '../physics/max-heap';
import { metersPerPixelFromTanHalfFov, MIN_DEPTH } from '../physics/projection';
import type { LineStyle } from './line-style';
import { markOverlay } from './pipeline/lit-layer';

export type CurveOptions = {
  readonly style: LineStyle;
  // 生成時に確保する頂点数の上限。バッファは生成時に1回だけ確保し、以後は差し替えない
  // (WebGPURenderer は描画対象ごとに頂点バッファの束縛をキャッシュしており、ジオメトリや
  // 属性ごと差し替えても新しい頂点は反映されない)。INITIAL_SEGMENTS の2倍以上を渡すこと。
  readonly maxVertices: number;
};

// t∈[0,1] の位置における曲線上の点を out へ書く。sample(0) と sample(1) が一致する(周期的
// である)なら、その曲線は自然に閉じた輪として描かれる。
export type CurveSampler = (t: number, out: THREE.Vector3) => void;

// t∈[0,1] の位置における頂点色を out へ書く。適応分割は頂点位置だけを見て区間を切るため、
// この関数は分割結果に影響しない — 頂点が確定したあとに、その t で1回だけ呼ばれる。
// **書いた色はマテリアル色に乗算される。** 線全体が単色なら渡さず setColor を使うこと
// (渡すと単色がマテリアル色と二重に掛かって暗くなる)。
export type CurveColorSampler = (t: number, out: THREE.Color) => void;

export type SetCurveOptions = {
  // 再サンプリングの要否を決める不透明な値。前回と === で異なるときだけ焼き直す — sample の
  // 中身が変わったことを表す値を呼び出し側が用意する(例: 元データの参照が変わったときだけ
  // 新しいオブジェクトを作る)。
  readonly revision: unknown;
  // 画面上のサジッタ目標を実距離に換算するための、現在の描画カメラ。
  readonly camera: THREE.Camera;
  // 適応分割を始める前に必ず頂点を置く t の列(昇順、両端の 0 と 1 を含む)。曲線の細部が
  // どこにあるかを知っているのは呼び出し側だけなので、知っているならここで渡す — 適応分割は
  // 弦の中点しか見ないため、1区間に何周ぶんも入るような曲線では中点がたまたま曲線上に乗り、
  // 分割済みと誤判定して区間まるごとが直線に化ける。2点未満なら t の等分割へフォールバックする。
  // 焼き直すかどうかは revision だけで決まるので、この列を変えたなら revision も変えること。
  readonly initialTs?: readonly number[];
  // 線の中で色が変わるときだけ渡す。省略すれば setStyle/setColor の単色で塗られる。
  readonly colorAt?: CurveColorSampler;
};

// 弦に対する曲線の膨らみ(サジッタ)の目標値 [px]。画面上のサジッタをこの値以下に抑える
// ように分割する。世界空間の許容量を固定にすると、寄るほど画面上のずれが線形に増えてしまう
// (ズームに連動しない歯止めはこの後の MAX_EDGE_TURN が担う)。
const MAX_EDGE_SAG_PX = 0.5;

// 1辺あたりに許す折れ角の上限。サジッタ目標だけに従うと、遠ズームで1区間が際限なく粗くなる
// (画面上のサジッタが縮まないぶん実距離の許容量が際限なく伸びる)ため、その歯止めとして残す。
const MAX_EDGE_TURN = (5 * Math.PI) / 180;

// initialTs を省いたときの初期分割数。閉曲線を1区間のまま評価すると t=0/1 が同一点で弦が
// 縮退するため、最低限これだけ分けてから適応分割に入る。
const INITIAL_SEGMENTS = 8;

// initialTs を省略したときの初期頂点列(t を INITIAL_SEGMENTS 等分したもの)。
const DEFAULT_INITIAL_TS: readonly number[] = Array.from(
  { length: INITIAL_SEGMENTS + 1 }, (_, i) => i / INITIAL_SEGMENTS,
);

// 頂点予算のうち初期頂点列へ回してよい割合。initialTs が長いと初期列だけで予算を使い切りうるので、
// 逸脱の大きいところへ回す分をここで残す。
const INITIAL_SEGMENT_BUDGET_RATIO = 0.5;

// 焼き直しの要否を決める代表スケールを測る点数。曲線上でカメラに最も寄っている点を拾うのが
// 目的なので初期頂点列の長さとは無関係でよく、毎フレーム走るぶんここは固定にしておく。
const SCALE_PROBE_POINTS = 8;

// 1区間に許す t 幅の下限。同じ点を返し続ける sample を渡されると逸脱がいくら分割しても
// 下がらないため、その区間へ予算を吸わせないための安全弁。頂点予算(maxVertices)より
// ずっと余裕を持たせてあり、通常は予算の方が先に効く。
const MIN_T_SPAN = 2 ** -24;

// スケール変化に対する焼き直し抑制の遊び幅。毎フレームの微小なズーム変化のたびに
// 焼き直さないための遊び。
const SCALE_REBAKE_RATIO = 1.2;

// カメラ視線方向の変化に対する焼き直し閾値(なす角の余弦)。適応分割は焼いた瞬間の視線方向を
// 基準に「手前だけ細かく、奥は MAX_EDGE_TURN 相当に粗く」焼くため、距離が変わらず向きだけ
// 変わる周回でも粗い区間が手前に回り込み得る。その回り込みが目立たない角度に MAX_EDGE_TURN と
// 同程度の値を採る。
const CAM_DIR_REBAKE_COS = Math.cos((5 * Math.PI) / 180);

// f32 の相対量子化幅(仮数23bit)。sample の座標系は LEO スケールの絶対座標を含みうるため、
// これをそのまま頂点バッファ(f32)へ書くと、その大きさに応じた量子化ノイズが生じ、近距離の
// カメラからは画面上のピクセル単位のずれとして見えてしまう。頂点バッファへは常にカメラ近傍の
// 基準点(pivot)からの差分だけを書き、その基準点をカメラの動きに追従させることでこれを防ぐ。
const F32_RELATIVE_EPS = 2 ** -24;

// pivot の更新を許す画面上の誤差上限 [px]。MAX_EDGE_SAG_PX(適応分割のサジッタ目標)より
// 十分小さい値にして、量子化誤差が分割の粗さに埋もれて見えなくなるようにする。
const PIVOT_MAX_ERROR_PX = 0.1;

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

  // 直近に適応分割で焼いた頂点(sample が返した座標系のまま、変換前)。倍精度で持つ理由は
  // pivot 自体の精度を落とさないため — GPU へ渡す positions(f32)は常にこの配列から pivot
  // を差し引いた差分として書く。並びは生成順で、t の昇順は nextVertex が持つ。
  private readonly bakedLocal: Float64Array;
  // 頂点ごとの色(colorAt が指定されたときだけ埋める)。位置と同じ生成順。
  private readonly bakedColor: Float32Array;
  private hasVertexColors = false;
  // 各頂点の曲線上の位置 t。分割は区間の両端の t から中点を求めるので、頂点と対で要る。
  private readonly ts: Float64Array;
  // 焼いた頂点を t 昇順に繋ぐ連結リスト(終端は -1)。分割は t の途中へ頂点を挿し込むため、
  // 生成順と描画順は一致しない。描画順を担うのはインデックスバッファの方で、頂点自体は
  // 生成順に置いたまま動かさない。
  private readonly nextVertex: Int32Array;
  private bakedCount = 0;
  private hasBaked = false;
  private lastRevision: unknown = undefined;
  private bakedScale: number | null = null;
  private readonly bakedCamFwd = new THREE.Vector3();

  // 頂点バッファ(f32)へ書く直前に bakedLocal の全頂点から差し引く基準点。sample が返す
  // 座標系のまま、カメラの現在位置に追従させる。
  private readonly pivot = new THREE.Vector3();
  private hasPivot = false;

  // setTransform が要求した変換そのもの(pivot 差し引き前)。line.position/quaternion は
  // pivot 分をこの変換で補って書き込むため、分割判定や pivot の追従判定など pivot に依存
  // しない計算はこちらを読む。
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

  // setCurve の呼び出しごとに一度だけ求め直す、カメラのワールド前方向・位置・画角換算値。
  // scaleAtLocal は分割の各テストから読むだけで、自分では取得し直さない。
  private readonly camFwd = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private camTanHalfFov = 0;
  private camOrthoHalfHeight = 0;
  private camNear = 0;

  // 未分割の区間を逸脱の大きい順に取り出す待ち行列。区間はその左端の頂点番号で表し、
  // 右端は nextVertex から辿る。
  private readonly pending: MaxHeap;

  // style はマテリアルと描画順、maxVertices は確保する頂点バッファの上限。style.dash が
  // あれば破線(LineDashedMaterial、頂点ごとの累積距離を焼く)。
  constructor(opts: CurveOptions) {
    const { style, maxVertices } = opts;
    const { color, opacity, renderOrder, dash } = style;
    this.maxVertices = maxVertices;
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
    // 色属性は使う前から束縛しておく。頂点カラーを後から使い始めるときに属性を足すと、
    // 束縛済みのジオメトリに対する差し替えになって新しいバッファが描画へ反映されない。
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
    // 頂点はバッファへ書き込んで needsUpdate を立てるだけで外接球を更新しないので、
    // 既定のフラスタム判定が使う外接球は古いまま(初期値は全頂点ゼロ)になる。
    this.line.frustumCulled = false;
    this.object = this.line;
    this.appliedStyle = style;
  }

  // 以後の scaleAtLocal が読むカメラのワールド前方向・位置・画角換算値・ニアプレーン距離を
  // 求め直す。
  private cacheCameraFrame(camera: THREE.Camera): void {
    camera.getWorldDirection(this.camFwd);
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    if (camera instanceof THREE.PerspectiveCamera) {
      this.camTanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
      this.camOrthoHalfHeight = 0;
      this.camNear = camera.near;
    } else if (camera instanceof THREE.OrthographicCamera) {
      this.camTanHalfFov = 0;
      this.camOrthoHalfHeight = (camera.top - camera.bottom) * 0.5;
      this.camNear = camera.near;
    } else {
      this.camTanHalfFov = Math.tan((50 * Math.PI) / 360);
      this.camOrthoHalfHeight = 0;
      this.camNear = MIN_DEPTH;
    }
  }

  // local 座標(sample が返す座標系、pivot 差し引き前)の点における m/px を返す。
  // cacheCameraFrame を先に呼んでおくこと。要求された変換(reqPosition/reqQuaternion)で
  // ワールドへ写す — pivot はカメラの動きに追従するだけの GPU バッファ上の便宜であって
  // sample→ワールドの変換そのものではないため、ここでは読まない。視点より手前の点は画面上の
  // どこにも映らないので、前方奥行きではなくカメラからの距離を尺度にする — そうしないと
  // metersPerPixelFromTanHalfFov 内の下限まで潰れ、背後に回り込んだ区間だけがサジッタ判定を
  // 常に外して頂点予算を使い切ってしまう。
  private scaleAtLocal(lx: number, ly: number, lz: number): number {
    this.scratchWorld.set(lx, ly, lz).applyQuaternion(this.reqQuaternion).add(this.reqPosition);
    const dx = this.scratchWorld.x - this.camPos.x;
    const dy = this.scratchWorld.y - this.camPos.y;
    const dz = this.scratchWorld.z - this.camPos.z;
    const depth = dx * this.camFwd.x + dy * this.camFwd.y + dz * this.camFwd.z;
    const effective = depth >= this.camNear
      ? depth
      : Math.max(this.camNear, Math.sqrt(dx * dx + dy * dy + dz * dz));
    if (this.camOrthoHalfHeight > 0) return (2 * this.camOrthoHalfHeight) / window.innerHeight;
    return metersPerPixelFromTanHalfFov(this.camTanHalfFov, effective, window.innerHeight);
  }

  // 焼き直し判定と pivot の追従判定に使う代表スケール(m/px)。sample(0) 1点だけを見ると、
  // その点が視点面をまたぐ曲線で値が乱高下し、SCALE_REBAKE_RATIO を毎フレーム跨いでしまう。
  // 分割の粗さを決めるのは曲線上で最もカメラに寄っている点なので、初期頂点列 ts から等間隔に
  // 抜いた SCALE_PROBE_POINTS+1 点の中の最小値を代表値とする。cacheCameraFrame を先に呼んでおくこと。
  private representativeScale(sample: CurveSampler, ts: readonly number[]): number {
    let minScale = Infinity;
    const last = ts.length - 1;
    for (let i = 0; i <= SCALE_PROBE_POINTS; i++) {
      sample(ts[Math.round((i * last) / SCALE_PROBE_POINTS)]!, this.scratchA);
      const s = this.scaleAtLocal(this.scratchA.x, this.scratchA.y, this.scratchA.z);
      if (s < minScale) minScale = s;
    }
    return minScale;
  }

  // カメラのワールド位置(cacheCameraFrame 済みの camPos)を、要求された変換の逆で sample の
  // 座標系へ戻す。pivot をカメラ近傍に据えるための基準点として使う。
  private localCameraPos(out: THREE.Vector3): THREE.Vector3 {
    this.scratchInvQuat.copy(this.reqQuaternion).invert();
    return out.copy(this.camPos).sub(this.reqPosition).applyQuaternion(this.scratchInvQuat);
  }

  // pivot 込みの実際の position/quaternion を line へ書き込む。要求された変換
  // (reqPosition/reqQuaternion)と現在の pivot からいつでも導出し直せる。
  private applyTransform(): void {
    this.line.quaternion.copy(this.reqQuaternion);
    this.scratchPivotWorld.copy(this.pivot).applyQuaternion(this.reqQuaternion);
    this.line.position.copy(this.reqPosition).add(this.scratchPivotWorld);
  }

  // 位置 t の頂点を積み、その番号を返す。連結リストへの接続は呼び出し側が行う。colorAt が
  // あれば同じ t で色も評価して積む。
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

  // 左端が頂点 seg の区間について、その区間を弦で代用したときの逸脱を返す。画面上のサジッタと
  // 折れ角のそれぞれを許容値との比にして、大きい方を採る — 単位の違う2つの基準を1つの順序に
  // まとめるための正規化で、1 を超える区間だけが分割に値する。
  private segmentError(seg: number, sample: CurveSampler): number {
    const right = this.nextVertex[seg]!;
    const t0 = this.ts[seg]!, t1 = this.ts[right]!;
    if (t1 - t0 <= MIN_T_SPAN) return 0;

    const a = seg * 3, b = right * 3;
    const x0 = this.bakedLocal[a]!, y0 = this.bakedLocal[a + 1]!, z0 = this.bakedLocal[a + 2]!;
    const x1 = this.bakedLocal[b]!, y1 = this.bakedLocal[b + 1]!, z1 = this.bakedLocal[b + 2]!;
    sample((t0 + t1) / 2, this.scratchM);
    const mx = this.scratchM.x, my = this.scratchM.y, mz = this.scratchM.z;

    const sagSq = distanceSqPointToSegment(mx, my, mz, x0, y0, z0, x1, y1, z1);
    const mpp = this.scaleAtLocal(mx, my, mz);
    const sagittaPx = mpp > 0 ? Math.sqrt(sagSq) / mpp : 0;

    const ax = mx - x0, ay = my - y0, az = mz - z0;
    const bx = x1 - mx, by = y1 - my, bz = z1 - mz;
    const aLen = Math.hypot(ax, ay, az), bLen = Math.hypot(bx, by, bz);
    const turn = aLen > 0 && bLen > 0
      ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (aLen * bLen))))
      : 0;

    return Math.max(sagittaPx / MAX_EDGE_SAG_PX, turn / MAX_EDGE_TURN);
  }

  // 初期頂点列を、予算のうち初期分割へ回してよい分に収まるよう間引いて使う。先頭から順に
  // 積んで打ち切ると曲線の後半がまるごと描かれなくなるので、間引くのは一様にする。
  private seedStride(ts: readonly number[]): number {
    const maxSeed = Math.max(2, Math.floor(this.maxVertices * INITIAL_SEGMENT_BUDGET_RATIO));
    return Math.max(1, Math.ceil((ts.length - 1) / (maxSeed - 1)));
  }

  // 初期頂点列から始めて、逸脱が最大の区間から順に二分していく。予算が尽きて打ち切っても、残った
  // 区間の逸脱はすべて最後に分割した区間以下 — 一箇所だけが粗いまま取り残されることはなく、
  // 曲線全体が一様に粗くなる方向へ劣化する。
  private rebake(sample: CurveSampler, ts: readonly number[], colorAt?: CurveColorSampler): void {
    this.bakedCount = 0;
    this.pending.clear();
    const last = ts.length - 1;
    const stride = this.seedStride(ts);
    const segmentCount = Math.ceil(last / stride);
    for (let i = 0; i <= segmentCount; i++) {
      const t = ts[Math.min(last, i * stride)]!;
      sample(t, this.scratchA);
      this.pushVertex(t, this.scratchA.x, this.scratchA.y, this.scratchA.z, colorAt);
      this.nextVertex[i] = i < segmentCount ? i + 1 : -1;
    }
    for (let i = 0; i < segmentCount; i++) this.pending.push(this.segmentError(i, sample), i);

    while (this.pending.topScore > 1 && this.bakedCount < this.maxVertices) {
      const left = this.pending.pop();
      const right = this.nextVertex[left]!;
      const tm = (this.ts[left]! + this.ts[right]!) / 2;
      sample(tm, this.scratchM);
      const mid = this.pushVertex(tm, this.scratchM.x, this.scratchM.y, this.scratchM.z, colorAt);
      this.nextVertex[mid] = right;
      this.nextVertex[left] = mid;
      this.pending.push(this.segmentError(left, sample), left);
      this.pending.push(this.segmentError(mid, sample), mid);
    }
  }

  // 曲線を(必要なら)焼き直し、GPU バッファへ反映する。revision・画面スケール・カメラ視線
  // 方向のいずれも前回と実質同じであれば焼き直しも GPU への再アップロードも省く。
  setCurve(sample: CurveSampler, opts: SetCurveOptions): void {
    const { revision, camera, initialTs, colorAt } = opts;
    const ts = initialTs && initialTs.length >= 2 ? initialTs : DEFAULT_INITIAL_TS;
    this.cacheCameraFrame(camera);
    const scaleNow = this.representativeScale(sample, ts);
    const scaleChanged = this.bakedScale === null
      || scaleNow / this.bakedScale > SCALE_REBAKE_RATIO || this.bakedScale / scaleNow > SCALE_REBAKE_RATIO;
    const camDirChanged = this.camFwd.dot(this.bakedCamFwd) < CAM_DIR_REBAKE_COS;
    // 色を後から使い始めたときは、焼いてある頂点に色が入っていないので必ず焼き直す
    // (そうしないと色属性が 0 のまま束縛されて線が黒くなる)。
    const colorsTurnedOn = colorAt !== undefined && !this.hasVertexColors;
    if (colorsTurnedOn) this.enableVertexColors();

    const revisionChanged = !this.hasBaked || revision !== this.lastRevision;
    const rebaked = revisionChanged || scaleChanged || camDirChanged || colorsTurnedOn;

    if (rebaked) {
      this.rebake(sample, ts, colorAt);
      this.hasBaked = true;
      this.lastRevision = revision;
      this.bakedScale = scaleNow;
      this.bakedCamFwd.copy(this.camFwd);
    }

    // pivot はカメラ近傍に据え続ける基準点。焼き直した頂点はまだ pivot 差し引き後の
    // positions へ反映されていないので rebake 時は必ず据え直し、それ以外は量子化誤差が
    // 画面上で無視できなくなったとき(カメラが pivot から離れたとき)だけ据え直す。
    const localCam = this.localCameraPos(this.scratchLocalCam);
    let pivotChanged = rebaked || !this.hasPivot;
    if (!pivotChanged) {
      const drift = localCam.distanceTo(this.pivot);
      pivotChanged = (drift * F32_RELATIVE_EPS) / scaleNow > PIVOT_MAX_ERROR_PX;
    }
    if (pivotChanged) {
      this.pivot.copy(localCam);
      this.hasPivot = true;
      this.applyTransform();
    }

    if (!rebaked && !pivotChanged) return;
    this.writePositions();
  }

  // マテリアルの頂点カラーを有効にする。
  private enableVertexColors(): void {
    this.hasVertexColors = true;
    (this.mat as THREE.LineBasicMaterial | THREE.LineDashedMaterial).vertexColors = true;
    this.mat.needsUpdate = true;
  }

  // 焼いてある頂点の色だけを colorAt で評価し直して GPU へ送る。頂点の位置と分割は動かさない。
  // まだ一度も焼いていなければ何もしない。
  setColors(colorAt: CurveColorSampler): void {
    if (!this.hasBaked) return;
    if (!this.hasVertexColors) this.enableVertexColors();
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
  // 同じ走査で書く)。頂点は生成順に置かれているので、t 昇順の並びはここで書くインデックスが担う。
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

  // マテリアルを作り直さず色だけ更新する。テーマ切替時も GPU の頂点バッファを維持できる。
  // 既に同じ色なら何もしない — 毎フレーム呼ばれても needsUpdate を立てないため。
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

  // sample の座標系をワールドへ写す変換を渡す。実際に line へ書く position/quaternion は
  // pivot 分の補正を経るため、渡した値がそのまま line.position/quaternion にはならない。
  setTransform(position: THREE.Vector3, quaternion?: THREE.Quaternion): void {
    this.reqPosition.copy(position);
    if (quaternion) this.reqQuaternion.copy(quaternion);
    else this.reqQuaternion.identity();
    this.applyTransform();
  }

  // 表示を要求する。頂点数が2未満の間は実際には隠れたままになる。
  setVisible(v: boolean): void {
    this.wantVisible = v;
    this.applyVisible();
  }

  // 折れ線は2点以上ないと描けないので、頂点数不足のときは表示要求に関わらず隠す。
  private applyVisible(): void {
    this.line.visible = this.wantVisible && this.vertexCount >= 2;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
