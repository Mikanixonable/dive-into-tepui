// 点列(時刻付き OrbitState)を1本の単色折れ線として描く汎用描画基盤。OrbitLine(解析的な楕円)の
// 兄弟で、こちらは数値予測軌道・履歴軌道など「任意の点列」を折れ線化する共通土台になる。
//
// 座標変換は physics/frame.ts へ委譲する二段構え:
//  - bake(点列 or frame が変わったときだけ, syncGeometry): 各サンプルの OrbitState を frame 相対へ
//    変換し(toFrameState)、位置と速度からエルミート細分した頂点を焼く。点ごとに回転角が違う
//    非剛体変形なので頂点を書き直す(慣性系なら無変換)。BufferGeometry と position 属性は
//    生成し直さず、確保済みバッファへ書き込んで needsUpdate を立てる — WebGPURenderer は
//    描画対象ごとに頂点バッファの束縛をキャッシュしており、ジオメトリごと差し替えると
//    新しい頂点が反映されない。
//  - un-bake(毎フレーム, syncTransform): 現在時刻 T の剛体回転(toInertialQuat)を line.quaternion
//    として与え、frame 相対頂点を慣性系へ戻す。全頂点一律なので O(1)。
//  - フローティングオリジン補正(毎フレーム): line.position = 地球中心の描画フレーム位置。
// THREE の合成は world = position + quaternion·vertex なので、原点まわりの un-bake 回転 →
// 平行移動の順で正しい。
import * as THREE from 'three/webgpu';
import { dot, len, v3 } from '../physics/vec3';
import { OrbitState, hermiteInterpolate, orbitState } from '../physics/orbital';
import { Frame, toFrameState, toInertialQuat } from '../physics/frame';
import type { Ephemeris } from '../physics/ephemeris';
import { FloatingOrigin } from '../game/floating-origin';

// 頂点は地球中心(ECI 原点)基準の frame 相対座標。line.position はその原点の描画フレーム位置。
const EARTH_CENTER = v3(0, 0, 0);

// 1辺あたりに許す接線の折れ角。隣り合う辺の向きがこの角度以下でしか変わらなければ、弦に対する
// 曲線の膨らみの割合も角度だけで決まる(≈ 角度/8)ので、滑らかさがズーム率に依らない。
const MAX_EDGE_TURN = (5 * Math.PI) / 180;

// 1本の折れ線が持てる頂点数。ここを超えた分は描かれない。バッファは生成時に確保して以後
// 差し替えないので(RenderObject が position 属性を生成時にキャッシュするため)、上限は固定。
// 予測軌道の上限サンプル数(PREDICT_MAX_SAMPLES = 2000)に対して、1辺あたり平均8本の
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

export class SampledLine {
  readonly line: THREE.Line;
  private readonly geom = new THREE.BufferGeometry();
  private readonly mat: THREE.LineBasicMaterial;
  private readonly positions = new Float32Array(MAX_VERTICES * 3);
  private vertexCount = 0;
  private lastSamples: readonly OrbitState[] | null = null;
  private lastFrame: Frame | null = null;
  private wantVisible = true;

  // 単色の折れ線マテリアル・ジオメトリを構築する。
  constructor(color: number, opacity = 0.85, renderOrder = 2) {
    this.mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.line = new THREE.Line(this.geom, this.mat);
    this.line.frustumCulled = false;
    this.line.renderOrder = renderOrder;
    this.line.visible = false;
  }

  // (点列, frame)が前回から変わったときだけ、頂点を frame 相対座標へ bake し直す(非剛体)。
  syncGeometry(samples: readonly OrbitState[], frame: Frame, ephemeris: Ephemeris): void {
    if (samples === this.lastSamples && frame === this.lastFrame) return;
    this.lastSamples = samples;
    this.lastFrame = frame;
    const verts: number[] = [];
    let prev: OrbitState | null = null;
    for (const sample of samples) {
      // hermiteInterpolate は座標系に依らない (時刻, 位置, 接線) の多項式なので、frame 相対の
      // 位置と速度をそのまま OrbitState に詰めて渡す(この慣性系ブランドは関数の外へ出ない)。
      const rel = toFrameState(frame, sample, ephemeris);
      const baked = orbitState(sample.t, rel.r, rel.v);
      if (prev !== null) {
        const chords = chordCount(prev, baked);
        for (let k = 1; k < chords; k++) {
          const { r } = hermiteInterpolate(prev, baked, prev.t + (baked.t - prev.t) * (k / chords));
          verts.push(r.x, r.y, r.z);
        }
      }
      verts.push(baked.r.x, baked.r.y, baked.r.z);
      prev = baked;
    }
    this.writeVertices(verts);
    this.applyVisible();
  }

  // 頂点列を position 属性へ書き込み、描画範囲をその本数に合わせる。
  private writeVertices(verts: readonly number[]): void {
    const n = Math.min(verts.length, this.positions.length);
    for (let i = 0; i < n; i++) this.positions[i] = verts[i]!;
    this.vertexCount = n / 3;
    this.geom.setDrawRange(0, this.vertexCount);
    this.geom.getAttribute('position').needsUpdate = true;
  }

  // 毎フレーム: 剛体 un-bake(line クォータニオン) + フローティングオリジン補正(line 位置)。
  // currentTime = 描画時刻(通常 simTime)。
  syncTransform(frame: Frame, currentTime: number, ephemeris: Ephemeris, fo: FloatingOrigin): void {
    const q = toInertialQuat(frame, currentTime, ephemeris);
    this.line.quaternion.set(q.x, q.y, q.z, q.w);
    this.line.position.copy(fo.RtoThreeV3(EARTH_CENTER));
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
