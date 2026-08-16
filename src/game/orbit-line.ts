// OrbitalElements から軌道楕円を描画する。頂点は中心天体(OrbitalElements.center)相対座標のまま保持し、
// フローティングオリジンによる Object3D 平行移動でその天体の ECI 位置へ置く。どの天体を
// 中心に描くかは OrbitalElements 自身が持つため、呼び出し側が外側で選び直すことはできない。
// 頂点の再サンプリングは軌道要素が閾値を超えて変化したときだけ行う。解像度そのものの決定
// (画面上のサジッタに応じた適応分割)は Curve に委ねる。楕円は天体自身の現在位置を貫くが、
// 天体メッシュは不透明・深度書き込み有りで先に描かれるため、深度テストだけで天体が手前に残る。
import * as THREE from 'three/webgpu';
import { OrbitalElements } from '../physics/elements';
import { FloatingOrigin } from './floating-origin';
import { Curve, CurveSampler } from '../render/curve';
import { ReferenceFrame, FrameTransform, toFramePoint } from '../physics/frame';
import type { Ephemeris } from '../physics/ephemeris';
import { Attractor } from '../physics/attractor';
import { add, v3, Vec3 } from '../physics/vec3';

// Curve の頂点予算。楕円は閉曲線なので初期分割・分割上限のみで足り、固定サンプル数は持たない。
const MAX_VERTICES = 4096;

// 再生成の閾値: これを超えて要素が動いたときだけ楕円を作り直す
const TOL_SMA = 3e-4; // 長半径の相対変化
const TOL_ECC = 3e-4; // 離心率の変化
const TOL_PLANE = Math.cos((0.12 * Math.PI) / 180); // 軌道面法線の角変化
const TOL_APSE = Math.cos((0.3 * Math.PI) / 180); // 近点方向の角変化(e が大きいときのみ)

export class OrbitLine {
  private readonly curve: Curve;
  readonly line: THREE.Object3D;
  // 直近に描いた軌道要素のスナップショット。sampler はこれを読む — 閾値を超えるまでは
  // 一切書き換えないことで、osculating 要素の微小なゆらぎによる楕円の振動を防ぐ。
  private snap: OrbitalElements | null = null;
  private snapFrame: ReferenceFrame | null = null;
  private snapTf: FrameTransform | null = null;
  private snapCenterPos: Vec3 = v3();
  // Curve へ渡す revision。楕円を作り直すたびに新しいオブジェクトへ差し替える。
  private revision: object = {};
  private suppressed = false;
  private displayEnabled = true;

  // 表示の有効/無効を切り替える。
  setDisplayEnabled(value: boolean): void {
    this.displayEnabled = value;
    this.applyVisible();
  }

  // 楕円線の表示を抑制する。抑制を解いたフレームでそのまま描き戻せるよう、直近の sync が
  // 有効な軌道要素を得ていた場合(snap がある)に限って表示へ戻す — 次の sync を待つと、
  // 抑制が解ける原因になった線が既に消えている1フレームのあいだ、どの線も出ない。
  setSuppressed(value: boolean): void {
    this.suppressed = value;
    this.applyVisible();
  }

  // 有効な軌道要素を得ている(snap がある)ときだけ、表示要求どおりに描く。
  private applyVisible(): void {
    this.curve.setVisible(this.displayEnabled && !this.suppressed && this.snap !== null);
  }

  // renderOrder は、この線が他の線と重なったときにどちらを手前へ描くかを決める —
  // 透明描画どうしの前後は描画順でしか決まらない。
  constructor(color: string | number, opacity = 0.5, renderOrder = 0) {
    this.curve = new Curve({ color, opacity, renderOrder, maxVertices: MAX_VERTICES });
    this.line = this.curve.object;
  }

  // 不透明度を書き換える。天体からの距離に応じて描画側がフェードさせる。
  setOpacity(opacity: number): void {
    this.curve.setOpacity(opacity);
  }

  setColor(color: string | number): void {
    this.curve.setColor(color);
  }

  // 離心近点角 E=t·2π を軌道要素で位置へ写す、閉曲線サンプラ。読むのは snap で、
  // revision が指す形状と焼かれる形状が常に一致する。
  private readonly sampler: CurveSampler = (t, out) => {
    const el = this.snap;
    if (!el) return;
    const b = el.a * Math.sqrt(1 - el.e * el.e);
    const E = t * Math.PI * 2;
    const x = el.a * (Math.cos(E) - el.e);
    const y = b * Math.sin(E);
    const rx = el.pHat.x * x + el.qHat.x * y;
    const ry = el.pHat.y * x + el.qHat.y * y;
    const rz = el.pHat.z * x + el.qHat.z * y;

    if (this.snapTf) {
      const rEci = add(this.snapCenterPos, v3(rx, ry, rz));
      const pFrame = toFramePoint(this.snapTf, rEci);
      out.set(pFrame.x, pFrame.y, pFrame.z);
    } else {
      out.set(rx, ry, rz);
    }
  };

  // 毎フレーム呼ぶ。fo = 描画のフローティングオリジン、camera = 画面上のサジッタを実距離へ
  // 換算するための描画カメラ。force = 要素が能動的に変化している間(推力中・ノード編集中)は
  // true。
  sync(
    el: OrbitalElements | null, fo: FloatingOrigin, camera: THREE.Camera, force = false,
    frame?: ReferenceFrame, displayTime?: number, ephemeris?: Ephemeris, attractors?: readonly Attractor[],
  ): void {
    if (!el || el.e >= 0.98 || !isFinite(el.a) || el.a <= 0) {
      this.snap = null;
      this.snapTf = null;
      this.applyVisible();
      return;
    }

    let tf: FrameTransform | null = null;
    if (frame && displayTime !== undefined && ephemeris && attractors) {
      tf = ephemeris.frameTransformAt(frame, displayTime, attractors);
    }

    if (tf) {
      this.curve.setTransform(fo.RtoThreeV3(tf.origin), new THREE.Quaternion(tf.q.x, tf.q.y, tf.q.z, tf.q.w));
    } else {
      this.curve.setTransform(fo.RtoThreeV3(el.center.state.r));
    }

    if (this.needsRegen(el, force, frame)) {
      this.revision = {};
      this.snap = el;
      this.snapFrame = frame ?? null;
      this.snapTf = tf;
      this.snapCenterPos = el.center.state.r;
    }

    this.curve.setCurve(this.sampler, { revision: this.revision, camera });
    this.applyVisible();
  }

  // 現在の要素が直近のスナップショットから許容誤差を超えて変化していれば true(要再生成)。
  private needsRegen(el: OrbitalElements, force: boolean, frame?: ReferenceFrame): boolean {
    if (!this.snap) return true;
    if (force) return true;
    if (this.snapFrame !== (frame ?? null)) return true;
    const s = this.snap;
    // 頂点は中心天体相対、平行移動は毎フレームの中心天体位置。中心が入れ替われば、
    // 別の天体を基準に焼いた形状をそのまま新しい中心へ動かすことになる。
    if (el.center.id !== s.center.id) return true;
    if (Math.abs(el.a - s.a) / s.a > TOL_SMA) return true;
    if (Math.abs(el.e - s.e) > TOL_ECC) return true;
    if (el.hHat.x * s.hHat.x + el.hHat.y * s.hHat.y + el.hHat.z * s.hHat.z < TOL_PLANE) return true;
    if (
      el.e > 0.01 &&
      el.pHat.x * s.pHat.x + el.pHat.y * s.pHat.y + el.pHat.z * s.pHat.z < TOL_APSE
    ) {
      return true;
    }
    return false;
  }

  dispose(): void {
    this.curve.dispose();
  }
}
