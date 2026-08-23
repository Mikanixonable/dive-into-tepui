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
import { LineStyle } from '../render/line-style';

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
  // Curve へ渡す revision。楕円を作り直すたびに新しいオブジェクトへ差し替える。
  private revision: object = {};

  // style.renderOrder は、この線が他の線と重なったときにどちらを手前へ描くかを決める —
  // 透明描画どうしの前後は描画順でしか決まらない。
  constructor(style: LineStyle) {
    this.curve = new Curve({ style, maxVertices: MAX_VERTICES });
    this.line = this.curve.object;
  }

  setStyle(style: LineStyle): void {
    this.curve.setStyle(style);
  }

  // 不透明度を書き換える。天体からの距離に応じて描画側がフェードさせる。
  setOpacity(opacity: number): void {
    this.curve.setOpacity(opacity);
  }

  setColor(color: string | number): void {
    this.curve.setColor(color);
  }

  setRenderOrder(renderOrder: number): void {
    this.curve.setRenderOrder(renderOrder);
  }

  // 離心近点角 E=t·2π を軌道要素で位置へ写す、閉曲線サンプラ。読むのは snap で、
  // revision が指す形状と焼かれる形状が常に一致する。頂点は中心天体相対の ECI オフセットで、
  // 表示座標系の回転はカメラ側が担う。これにより、軌道要素の再生成時刻と現在時刻の回転を
  // 混ぜず、回転座標系でも楕円が慣性空間上の同じ軌道を保つ。
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
    out.set(rx, ry, rz);
  };

  // 毎フレーム呼ぶ。fo = 描画のフローティングオリジン、camera = 画面上のサジッタを実距離へ
  // 換算するための描画カメラ。el が null なら軌道要素を持たない状態として非表示にする。
  // opts.force = 要素が能動的に変化している間(推力中・ノード編集中)は true。
  sync(
    el: OrbitalElements | null, fo: FloatingOrigin, camera: THREE.Camera,
    opts: {
      readonly force?: boolean;
    } = {},
  ): void {
    const { force = false } = opts;
    if (!el || el.e >= 0.98 || !isFinite(el.a) || el.a <= 0) {
      this.snap = null;
      this.curve.setVisible(false);
      return;
    }

    // OrbitLineの頂点はECI相対、シーンもECI基準なので、回転クォータニオンは恒等にする。
    // 回転座標系はMapCameraの視点・姿勢で表現する。ここへ現在時刻のフレーム回転を掛けると、
    // 再生成時刻に焼いた軌道形状だけが回転し続け、船の現在位置から外れていく。
    this.curve.setTransform(fo.RtoThreeV3(el.center.state.r));

    if (this.needsRegen(el, force)) {
      this.revision = {};
      this.snap = el;
    }

    this.curve.setCurve(this.sampler, { revision: this.revision, camera });
    this.curve.setVisible(true);
  }

  // 現在の要素が直近のスナップショットから許容誤差を超えて変化していれば true(要再生成)。
  private needsRegen(el: OrbitalElements, force: boolean): boolean {
    if (!this.snap) return true;
    if (force) return true;
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
