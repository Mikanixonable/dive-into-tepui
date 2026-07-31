// 点列(時刻付き OrbitState)を1本の単色折れ線として描く汎用描画基盤。OrbitLine(解析的な楕円)の
// 兄弟で、こちらは数値予測軌道・履歴軌道など「任意の点列」を折れ線化する共通土台になる。
//
// 座標変換は physics/frame.ts へ委譲する二段構え:
//  - bake(点列 or frame が変わったときだけ, syncGeometry): 各サンプルの OrbitState を frame 相対へ
//    変換し(toFrameState)、頂点には位置 r だけを焼く(速度 v は将来のエルミート補間用)。点ごとに
//    回転角が違う非剛体変形なので頂点バッファを作り直す(慣性系なら無変換)。
//  - un-bake(毎フレーム, syncTransform): 現在時刻 T の剛体回転(toInertialQuat)を line.quaternion
//    として与え、frame 相対頂点を慣性系へ戻す。全頂点一律なので O(1)。
//  - フローティングオリジン補正(毎フレーム): line.position = 地球中心の描画フレーム位置。
// THREE の合成は world = position + quaternion·vertex なので、原点まわりの un-bake 回転 →
// 平行移動の順で正しい。
import * as THREE from 'three/webgpu';
import { v3 } from '../physics/vec3';
import { OrbitState } from '../physics/orbital';
import { Frame, toFrameState, toInertialQuat } from '../physics/frame';
import type { Ephemeris } from '../physics/ephemeris';
import { FloatingOrigin } from '../game/floating-origin';

// 折れ線の1点は時刻付き状態ベクトル(OrbitState)そのもの — 予測点列もエンティティの履歴も
// 同じ型なのでそのまま渡せる。
// bake は位置 r だけを使うが、速度 v も frame 相対へ変換される — 将来のエルミート補間
// (頂点間を速度で滑らかに繋ぐ)の接線として供給しておく。

// 頂点は地球中心(ECI 原点)基準の frame 相対座標。line.position はその原点の描画フレーム位置。
const EARTH_CENTER = v3(0, 0, 0);

export class SampledLine {
  readonly line: THREE.Line;
  private geom = new THREE.BufferGeometry();
  private readonly mat: THREE.LineBasicMaterial;
  private lastSamples: readonly OrbitState[] | null = null;
  private lastFrame: Frame | null = null;
  private wantVisible = true;

  // 単色の折れ線マテリアル・ジオメトリを構築する。
  constructor(color: number, opacity = 0.85, renderOrder = 2) {
    this.mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
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
    const arr = new Float32Array(samples.length * 3);
    for (let i = 0; i < samples.length; i++) {
      // OrbitState 全体を frame 相対へ変換する。頂点には位置 rel.r だけを焼く。速度 rel.v は
      // エルミート補間用の接線だが、補間未実装の現状は使わない(実装時にここで保持して密にする)。
      const rel = toFrameState(frame, samples[i]!, ephemeris);
      arr[i * 3] = rel.r.x;
      arr[i * 3 + 1] = rel.r.y;
      arr[i * 3 + 2] = rel.r.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    this.geom.dispose();
    this.geom = geo;
    this.line.geometry = geo;
    this.applyVisible();
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
    this.line.visible = this.wantVisible && (this.lastSamples?.length ?? 0) >= 2;
  }

  // ジオメトリ・マテリアルを解放する。
  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
