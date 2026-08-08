// 点列(時刻付き OrbitState)を1本の単色折れ線として描く汎用描画基盤。OrbitLine(解析的な楕円)の
// 兄弟で、こちらは計画軌道・予測軌道・履歴軌道など「任意の点列」を折れ線化する共通土台になる。
//
// 座標変換は physics/frame.ts / physics/ephemeris.ts へ委譲する二段構え:
//  - bake(点列 or frame が変わったときだけ, syncGeometry): 各サンプルの OrbitState をその時刻の
//    座標系相対へ変換し(frameTransformAt→toFrameState)、位置と速度からエルミート細分した頂点を
//    焼く。点ごとに座標系の姿勢・原点が違う非剛体変形なので頂点を書き直す(慣性系なら無変換)。
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
import { dot, len } from '../physics/vec3';
import { OrbitState, hermiteInterpolate, orbitState } from '../physics/orbital-state';
import { Frame, toFrameState } from '../physics/frame';
import type { Ephemeris } from '../physics/ephemeris';
import { FloatingOrigin } from '../game/floating-origin';

// 1辺あたりに許す接線の折れ角。隣り合う辺の向きがこの角度以下でしか変わらなければ、弦に対する
// 曲線の膨らみの割合も角度だけで決まる(≈ 角度/8)ので、滑らかさがズーム率に依らない。
const MAX_EDGE_TURN = (5 * Math.PI) / 180;

// 1本の折れ線が持てる頂点数。ここを超えた分は描かれない。バッファは生成時に確保して以後
// 差し替えないので(RenderObject が position 属性を生成時にキャッシュするため)、上限は固定。
// 点列の上限サンプル数(PLAN_ARC_MAX_SAMPLES = 2000)に対して、1辺あたり平均8本の
// エルミート細分まで吸収できる幅。
const MAX_VERTICES = 16384;

// 区間 a→b を近似する弦の本数。両端の接線がなす角を MAX_EDGE_TURN ごとに割る。
// 時刻が同じ/速度が消えている区間は曲線が定まらないので分割しない。
function chordCount(a: OrbitState, b: OrbitState): number {
  const speedA = len(a.v);
  const speedB = len(b.v);
  if (a.t === b.t || speedA === 0 || speedB === 0) return 1;
  const turn = Math.acos(Math.max(-1, Math.min(1, dot(a.v, b.v) / (speedA * speedB))));
  return Math.max(1, Math.ceil(turn / MAX_EDGE_TURN));
}

// 破線パターン。dashSize/gapSize は表示座標系の実距離 [m](LineDashedMaterial の
// lineDistance 属性がそのままこの単位で評価されるため、scale=1 前提でメートルを直接渡せる)。
export type DashPattern = { readonly dashSize: number; readonly gapSize: number };

export class SampledLine {
  readonly line: THREE.Line;
  private readonly geom = new THREE.BufferGeometry();
  private readonly mat: THREE.LineBasicMaterial | THREE.LineDashedMaterial;
  private readonly positions = new Float32Array(MAX_VERTICES * 3);
  // 破線のときだけ確保する、始点からの累積距離 [m](LineDashedMaterial が読む lineDistance 属性)。
  private readonly lineDistances: Float32Array | null;
  private vertexCount = 0;
  private lastSamples: readonly OrbitState[] | null = null;
  private lastFrame: Frame | null = null;
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

  // (点列, frame)が前回から変わったときだけ、頂点を frame 相対座標へ bake し直す(非剛体)。
  // 破線のときは、同じ頂点列挙のついでに始点からの累積距離も焼く。
  syncGeometry(samples: readonly OrbitState[], frame: Frame, ephemeris: Ephemeris): void {
    if (samples === this.lastSamples && frame === this.lastFrame) return;
    this.lastSamples = samples;
    this.lastFrame = frame;
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
    let prev: OrbitState | null = null;
    for (const sample of samples) {
      // hermiteInterpolate は座標系に依らない (時刻, 位置, 接線) の多項式なので、座標系相対の
      // 位置と速度をそのまま OrbitState に詰めて渡す(この慣性系ブランドは関数の外へ出ない)。
      // 座標系の原点・姿勢はサンプルごとの時刻で評価する(回転系は時刻で向きが変わるため)。
      const rel = toFrameState(ephemeris.frameTransformAt(frame, sample.t), sample);
      const baked = orbitState(sample.t, rel.r, rel.v);
      if (prev !== null) {
        const chords = chordCount(prev, baked);
        for (let k = 1; k < chords; k++) {
          const { r } = hermiteInterpolate(prev, baked, prev.t + (baked.t - prev.t) * (k / chords));
          pushVertex(r);
        }
      }
      pushVertex(baked.r);
      prev = baked;
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
  syncTransform(frame: Frame, currentTime: number, ephemeris: Ephemeris, fo: FloatingOrigin): void {
    const tf = ephemeris.frameTransformAt(frame, currentTime);
    this.line.quaternion.set(tf.q.x, tf.q.y, tf.q.z, tf.q.w);
    this.line.position.copy(fo.RtoThreeV3(tf.origin));
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

  // ジオメトリ・マテリアルを解放する。
  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
