// 点列(時刻付き KinematicState)を1本の単色折れ線として描く汎用描画基盤。OrbitLine(解析的な楕円)の
// 兄弟で、こちらは計画軌道・予測軌道・履歴軌道など「任意の点列」を折れ線化する共通土台になる。
//
// 座標変換は physics/frame.ts / physics/ephemeris.ts へ委譲する二段構え:
//  - bake(点列・frame・画面スケールが変わったときだけ, syncGeometry): 各サンプルの KinematicState を
//    その時刻の座標系相対へ変換し(frameTransformAt→toFrameState)、位置と速度からエルミート細分した
//    頂点を焼く。点ごとに座標系の姿勢・原点が違う非剛体変形なので頂点を書き直す(慣性系なら無変換)。
//    BufferGeometry と position 属性は生成し直さず、確保済みバッファへ書き込んで needsUpdate を
//    立てる — WebGPURenderer は描画対象ごとに頂点バッファの束縛をキャッシュしており、ジオメトリ
//    ごと差し替えると新しい頂点が反映されない。
//  - un-bake(毎フレーム, syncTransform): 現在時刻 T の座標系の剛体運動(frameTransformAt)を
//    line.quaternion として与え、座標系相対頂点を慣性系へ戻す。全頂点一律なので O(1)。
//  - フローティングオリジン補正(毎フレーム): line.position = 座標系原点の描画フレーム位置
//    (原点が動く座標系でもここだけ直せば済むよう、頂点は書き換えない)。
// THREE の合成は world = position + quaternion·vertex なので、原点まわりの un-bake 回転 →
// 平行移動の順で正しい。
import * as THREE from 'three/webgpu';
import { dot, len, Vec3 } from '../physics/vec3';
import { KinematicState, hermiteInterpolate, kinematicState } from '../physics/kinematic-state';
import { ReferenceFrame, toFrameState } from '../physics/frame';
import { Attractor } from '../physics/attractor';
import type { Ephemeris } from '../physics/ephemeris';
import { FloatingOrigin } from '../game/floating-origin';

// 世界(絶対 ECI)座標1点における画面上の m/px を返す関数。game/camera/camera-system.ts の
// ScaleFn と同じ形だが、render/ は game/ に依存しない規約のためここで独立に定義する
// (構造的に同じ関数型なので、呼び出し側は camera-system.ts の ScaleFn をそのまま渡せる)。
export type ScaleAtFn = (worldPos: Vec3) => number;

// 1辺あたりに許す接線の折れ角の上限。ズームで画面上のサジッタが縮まないぶん際限なく
// 細分してしまわないよう、遠ズームでも今より粗くならない歯止めとして残す。
const MAX_EDGE_TURN = (5 * Math.PI) / 180;

// 弦に対する曲線の膨らみ(サジッタ)の目標値 [px]。サジッタ ≈ 弦長・折れ角/8 なので、
// 画面上のサジッタをこの値以下に抑えるように、区間ごとに折れ角の許容量を m/px から逆算する
// (desiredChordCount 参照)。固定ではなく画面スケール依存にするのがこの定数の存在理由 — 弦の
// 折れ角を固定にすると、ワールド空間のサジッタは固定のままズームだけが変わるので、寄るほど
// 画面上のずれが線形に増えてしまう(LEO で最大約 3.9km、camDist=1e5 では約 25px)。
const MAX_EDGE_SAG_PX = 0.5;

// 1本の折れ線が持てる頂点数。ここを超えた分は描かれない。バッファは生成時に確保して以後
// 差し替えないので(RenderObject が position 属性を生成時にキャッシュするため)、上限は固定。
const MAX_VERTICES = 16384;

// 区間 a→b(bake 済み)を近似する弦の本数を、予算(MAX_VERTICES)を無視して画面上のサジッタ目標
// だけから求める。scale は絶対 ECI 位置→m/px を返す関数で、区間の始点(bake 前の絶対位置)で
// 1回だけ評価する。時刻が同じ/速度が消えている区間は曲線が定まらないので分割しない。
function desiredChordCount(a: KinematicState, b: KinematicState, refPoint: Vec3, scale: ScaleAtFn): number {
  const speedA = len(a.v);
  const speedB = len(b.v);
  if (a.t === b.t || speedA === 0 || speedB === 0) return 1;
  const turn = Math.acos(Math.max(-1, Math.min(1, dot(a.v, b.v) / (speedA * speedB))));
  const chordM = Math.hypot(b.r.x - a.r.x, b.r.y - a.r.y, b.r.z - a.r.z);
  const mpp = scale(refPoint);
  const chordPx = mpp > 0 ? chordM / mpp : 0;
  const allowedTurn = chordPx > 0 ? Math.min(MAX_EDGE_TURN, (8 * MAX_EDGE_SAG_PX) / chordPx) : MAX_EDGE_TURN;
  return Math.max(1, Math.ceil(turn / allowedTurn));
}

// bake の再実行を見送ってよい画面スケールの変化幅。毎フレームの微小なズーム変化のたびに
// 焼き直さないための遊び。
const SCALE_REBAKE_RATIO = 1.2;

// 破線パターン。dashSize/gapSize は表示座標系の実距離 [m](LineDashedMaterial の
// lineDistance 属性がそのままこの単位で評価されるため、scale=1 前提でメートルを直接渡せる)。
// 呼び出し側が毎フレーム書き換えてよい。
export type DashPattern = { readonly dashSize: number; readonly gapSize: number };

export class SampledLine {
  readonly line: THREE.Line;
  private readonly geom = new THREE.BufferGeometry();
  private readonly mat: THREE.LineBasicMaterial | THREE.LineDashedMaterial;
  private readonly positions = new Float32Array(MAX_VERTICES * 3);
  // 破線のときだけ確保する、始点からの累積距離 [m](LineDashedMaterial が読む lineDistance 属性)。
  private readonly lineDistances: Float32Array | null;
  private vertexCount = 0;
  private lastSamples: readonly KinematicState[] | null = null;
  private lastFrame: ReferenceFrame | null = null;
  private lastScale: number | null = null;
  private wantVisible = true;

  // 単色の折れ線マテリアル・ジオメトリを構築する。dash を渡すと破線になる。
  constructor(color: number, opacity = 0.85, renderOrder = 2, dash?: DashPattern) {
    this.mat = dash
      ? new THREE.LineDashedMaterial({
        color, transparent: true, opacity, depthWrite: false, dashSize: dash.dashSize, gapSize: dash.gapSize,
      })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    if (dash) {
      this.lineDistances = new Float32Array(MAX_VERTICES);
      this.geom.setAttribute('lineDistance', new THREE.BufferAttribute(this.lineDistances, 1));
    } else {
      this.lineDistances = null;
    }
    this.line = new THREE.Line(this.geom, this.mat);
    this.line.frustumCulled = false;
    this.line.renderOrder = renderOrder;
    this.line.visible = false;
  }

  // (点列, frame, 画面スケール)が前回から変わったときだけ、頂点を frame 相対座標へ bake し直す
  // (非剛体)。scale は絶対 ECI 位置→m/px(区間ごとの折れ角の許容量をこれで決める — desiredChordCount
  // 参照)。スケールは関数の同一性では比較できない(呼び出し側は毎フレーム新しいクロージャを渡しうる)
  // ので、点列中央のサンプルで一度評価した数値を SCALE_REBAKE_RATIO 幅で比較する。
  // 破線のときは、同じ頂点列挙のついでに始点からの累積距離も焼く。
  syncGeometry(
    samples: readonly KinematicState[], frame: ReferenceFrame, ephemeris: Ephemeris, scale: ScaleAtFn,
    attractors: readonly Attractor[],
  ): void {
    const scaleNow = samples.length > 0 ? scale(samples[Math.floor(samples.length / 2)]!.r) : 1;
    const scaleChanged = this.lastScale === null
      || scaleNow / this.lastScale > SCALE_REBAKE_RATIO || this.lastScale / scaleNow > SCALE_REBAKE_RATIO;
    if (samples === this.lastSamples && frame === this.lastFrame && !scaleChanged) return;
    this.lastSamples = samples;
    this.lastFrame = frame;
    this.lastScale = scaleNow;

    // hermiteInterpolate は座標系に依らない (時刻, 位置, 接線) の多項式なので、座標系相対の
    // 位置と速度をそのまま KinematicState に詰めて渡す(この慣性系ブランドは関数の外へ出ない)。
    // 座標系の原点・姿勢はサンプルごとの時刻で評価する(回転系は時刻で向きが変わるため)。
    const baked = samples.map((s) => {
      const rel = toFrameState(ephemeris.frameTransformAt(frame, s.t, attractors), s);
      return kinematicState(s.t, rel.r, rel.v);
    });

    // 区間ごとの希望弦数を、予算を等分した上限でクランプする。scale はカメラ背後・カメラ近傍で
    // depth が下限に張り付いて m/px が桁違いに小さくなりうる(projection.ts の MIN_DEPTH)ため、
    // クランプ無しでは背後の1区間だけが desired を数桁膨れ上がらせて予算をほぼ独占し、画面内の
    // 区間まで最低本数まで潰れて逆に粗くなる。全区間へ均等に割った上限を先に掛けておけば、
    // どの区間も残り予算を独占できず、合計は定義上 budget を超えない。
    // scale の評価点は bake 前の絶対位置(desiredChordCount が要求する空間)。
    const edgeCount = Math.max(0, baked.length - 1);
    const budget = MAX_VERTICES - 1; // 先頭の1頂点を除いた、辺に使える頂点の枠
    const maxPerEdge = edgeCount > 0 ? Math.max(1, Math.floor(budget / edgeCount)) : 1;
    const chordCounts: number[] = [];
    for (let i = 1; i < baked.length; i++) {
      chordCounts.push(Math.min(maxPerEdge, desiredChordCount(baked[i - 1]!, baked[i]!, samples[i - 1]!.r, scale)));
    }

    const verts: number[] = [];
    const dists: number[] | null = this.lineDistances ? [] : null;
    let dist = 0;
    let lastR: { x: number; y: number; z: number } | null = null;
    const pushVertex = (r: { x: number; y: number; z: number }): void => {
      if (dists) {
        if (lastR) dist += Math.hypot(r.x - lastR.x, r.y - lastR.y, r.z - lastR.z);
        dists.push(dist);
      }
      verts.push(r.x, r.y, r.z);
      lastR = r;
    };
    if (baked.length > 0) pushVertex(baked[0]!.r);
    for (let i = 1; i < baked.length; i++) {
      const a = baked[i - 1]!;
      const b = baked[i]!;
      const chords = chordCounts[i - 1]!;
      for (let k = 1; k < chords; k++) {
        const { r } = hermiteInterpolate(a, b, a.t + (b.t - a.t) * (k / chords));
        pushVertex(r);
      }
      pushVertex(b.r);
    }
    this.writeVertices(verts, dists);
    this.applyVisible();
  }

  // 頂点列を position 属性へ書き込み、描画範囲をその本数に合わせる。dists は破線のときだけ
  // lineDistance 属性へ書き込む。
  private writeVertices(verts: readonly number[], dists: readonly number[] | null): void {
    const n = Math.min(verts.length, this.positions.length);
    for (let i = 0; i < n; i++) this.positions[i] = verts[i]!;
    this.vertexCount = n / 3;
    this.geom.setDrawRange(0, this.vertexCount);
    this.geom.getAttribute('position').needsUpdate = true;
    if (this.lineDistances && dists) {
      const m = Math.min(dists.length, this.lineDistances.length);
      for (let i = 0; i < m; i++) this.lineDistances[i] = dists[i]!;
      this.geom.getAttribute('lineDistance').needsUpdate = true;
    }
  }

  // 毎フレーム: 剛体 un-bake(line クォータニオン) + フローティングオリジン補正(line 位置 =
  // 座標系原点)。currentTime = 描画時刻(通常 simTime)。
  syncTransform(
    frame: ReferenceFrame, currentTime: number, ephemeris: Ephemeris, fo: FloatingOrigin,
    attractors: readonly Attractor[],
  ): void {
    const tf = ephemeris.frameTransformAt(frame, currentTime, attractors);
    this.line.quaternion.set(tf.q.x, tf.q.y, tf.q.z, tf.q.w);
    this.line.position.copy(fo.RtoThreeV3(tf.origin));
  }

  // 表示を要求する。頂点数が2未満の間は実際には隠れたままになる。
  setVisible(v: boolean): void {
    this.wantVisible = v;
    this.applyVisible();
  }

  get visible(): boolean {
    return this.line.visible;
  }

  // 破線パターンを書き換える。破線でないマテリアルでは何もしない。
  setDash(dashSize: number, gapSize: number): void {
    if (this.mat instanceof THREE.LineDashedMaterial) {
      this.mat.dashSize = dashSize;
      this.mat.gapSize = gapSize;
    }
  }

  // 折れ線は2点以上ないと描けないので、頂点数不足のときは表示要求に関わらず隠す。
  private applyVisible(): void {
    this.line.visible = this.wantVisible && this.vertexCount >= 2;
  }

  // ジオメトリ・マテリアルを解放する。
  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
