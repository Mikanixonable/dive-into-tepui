// OrbitalElements から軌道楕円を描画する。頂点は中心天体(OrbitalElements.center)相対座標のまま保持し、
// フローティングオリジンによる Object3D 平行移動でその天体の ECI 位置へ置く。どの天体を
// 中心に描くかは OrbitalElements 自身が持つため、呼び出し側が外側で選び直すことはできない。
// 頂点の再サンプリングは軌道要素が閾値を超えて変化したときだけ行う。解像度そのものの決定
// (画面上のサジッタに応じた適応分割)は Curve に委ねる。
import * as THREE from 'three/webgpu';
import { OrbitalElements } from '../physics/elements';
import { Vec3 } from '../physics/vec3';
import { FloatingOrigin } from './floating-origin';
import { Curve, CurveSampler } from '../render/curve';

// Curve の頂点予算。楕円は閉曲線なので初期分割・分割上限のみで足り、固定サンプル数は持たない。
const MAX_VERTICES = 4096;

// 再生成の閾値: これを超えて要素が動いたときだけ楕円を作り直す
const REGEN_MIN_INTERVAL_MS = 120; // 最短再生成間隔
const TOL_SMA = 3e-4; // 長半径の相対変化
const TOL_ECC = 3e-4; // 離心率の変化
const TOL_PLANE = Math.cos((0.12 * Math.PI) / 180); // 軌道面法線の角変化
const TOL_APSE = Math.cos((0.3 * Math.PI) / 180); // 近点方向の角変化(e が大きいときのみ)

// この楕円上に乗っている天体(参照軌道線が表す天体そのもの)。position は軌道線と同じ
// 中心天体相対座標、radius は物理半径 [m]。角度近似ではなく実際の線分と球の距離で除外する。
export interface OrbitLineExcludeNearBody {
  readonly position: Vec3;
  readonly radius: number;
}

export class OrbitLine {
  private readonly curve: Curve;
  readonly line: THREE.Object3D;
  private snap: { a: number; e: number; hHat: Vec3; pHat: Vec3 } | null = null;
  // Curve へ渡す revision。楕円を作り直すたびに新しいオブジェクトへ差し替える。
  private revision: object = {};
  private lastRegen = 0;
  private suppressed = false;
  private displayEnabled = true;
  private el: OrbitalElements | null = null;

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
    this.curve = new Curve({
      color, opacity, renderOrder, maxVertices: MAX_VERTICES, perVertexFade: true,
    });
    this.line = this.curve.object;
  }

  // 離心近点角 E=t·2π を軌道要素で位置へ写す、閉曲線サンプラ。
  private readonly sampler: CurveSampler = (t, out) => {
    const el = this.el;
    if (!el) return;
    const b = el.a * Math.sqrt(1 - el.e * el.e);
    const E = t * Math.PI * 2;
    const x = el.a * (Math.cos(E) - el.e);
    const y = b * Math.sin(E);
    out.set(
      el.pHat.x * x + el.qHat.x * y,
      el.pHat.y * x + el.qHat.y * y,
      el.pHat.z * x + el.qHat.z * y,
    );
  };

  // 毎フレーム呼ぶ。fo = 描画のフローティングオリジン、camera = 画面上のサジッタを実距離へ
  // 換算するための描画カメラ。force = 要素が能動的に変化している間(推力中・ノード編集中)は
  // true。excludeNearBody は、この楕円上に乗っている天体自身の位置と半径 — その天体のメッシュ
  // と深度が競合してチラつくのを避けるため、天体に近づくほど線を薄くし、完全に透明になる
  // 内側は描画自体から外す。
  sync(
    el: OrbitalElements | null, fo: FloatingOrigin, camera: THREE.Camera, force = false,
    excludeNearBody?: OrbitLineExcludeNearBody,
  ): void {
    if (!el || el.e >= 0.98 || !isFinite(el.a) || el.a <= 0) {
      this.snap = null;
      this.applyVisible();
      return;
    }
    // 頂点を自機相対座標で毎フレーム書き直すと、osculating 要素の微小なゆらぎで楕円が
    // 振動して見える。頂点は中心天体相対座標のまま固定し、平行移動だけで動かす。
    this.curve.setTransform(fo.RtoThreeV3(el.center.state.r));
    this.el = el;

    if (this.needsRegen(el, force)) {
      this.revision = {};
      this.snap = { a: el.a, e: el.e, hHat: { ...el.hHat }, pHat: { ...el.pHat } };
      this.lastRegen = performance.now();
    }

    this.curve.setCurve(this.sampler, {
      revision: this.revision,
      camera,
      excludeSphere: excludeNearBody
        ? { center: new THREE.Vector3(excludeNearBody.position.x, excludeNearBody.position.y, excludeNearBody.position.z), radius: excludeNearBody.radius }
        : undefined,
    });
    this.applyVisible();
  }

  // 現在の要素が直近のスナップショットから許容誤差を超えて変化していれば true(要再生成)。
  private needsRegen(el: OrbitalElements, force: boolean): boolean {
    if (!this.snap) return true;
    const now = performance.now();
    if (now - this.lastRegen < REGEN_MIN_INTERVAL_MS) return false;
    if (force) return true;
    const s = this.snap;
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
