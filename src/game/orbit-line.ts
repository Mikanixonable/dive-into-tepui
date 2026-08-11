// OrbitalElements から軌道楕円を描画する。頂点は中心天体(OrbitalElements.center)相対座標のまま保持し、
// フローティングオリジンによる Object3D 平行移動でその天体の ECI 位置へ置く。どの天体を
// 中心に描くかは OrbitalElements 自身が持つため、呼び出し側が外側で選び直すことはできない。
// ジオメトリの再生成は軌道要素が閾値を超えて変化したときだけ行う。描画そのものは Curve に委ねる。
import * as THREE from 'three/webgpu';
import { OrbitalElements } from '../physics/elements';
import { Vec3 } from '../physics/vec3';
import { pointSphereFade, segmentIntersectsSphere } from '../physics/orbit-line-geometry';
import { FloatingOrigin } from './floating-origin';
import { Curve } from '../render/curve';

// フェードの再計算を省く天体の移動量。天体半径に対するこの割合より小さく動いただけなら、
// フェード帯の中の各頂点の不透明度は視認できるほど変わらない。
const FADE_SKIP_SHIFT_RATIO = 1 / 16;

// 離心近点角 E で一様サンプリング + 自機付近を密にする非線形マッピング。
const POINT_COUNT = 2048;

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
  private readonly positions: Float32Array;
  private readonly indices: Uint32Array;
  // 頂点ごとの不透明度係数(0=透明〜1=不透明)。
  private readonly fade: Float32Array;
  // fade が全頂点 1・全セグメント描画の状態にあるか。楕円上に天体が乗っていない線
  // (自機・ターゲット・敵の軌道線)は毎フレームこの状態のままなので、GPU への
  // 転送を繰り返さずに済ませる。
  private fadeNeutral = true;
  // 直近に applyFade へ適用した excludeNearBody の値。
  private lastExclude: OrbitLineExcludeNearBody | null = null;
  private snap: { a: number; e: number; hHat: Vec3; pHat: Vec3; focusE?: number } | null = null;
  private lastRegen = 0;
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
    this.positions = new Float32Array((POINT_COUNT + 1) * 3);
    this.indices = new Uint32Array(POINT_COUNT * 2);
    this.fade = new Float32Array(POINT_COUNT + 1).fill(1);
    this.resetIndices();
    this.curve = new Curve({
      color, opacity, renderOrder, maxVertices: POINT_COUNT + 1, perVertexFade: true,
    });
    this.line = this.curve.object;
  }

  // 毎フレーム呼ぶ。fo = 描画のフローティングオリジン。force = 要素が能動的に変化している
  // 間(推力中・ノード編集中)は true。densifyNear は中心天体相対座標で、その付近に頂点を
  // 密に配置する。excludeNearBody は、この楕円上に乗っている天体自身の位置と半径 — その
  // 天体のメッシュと深度が競合してチラつくのを避けるため、天体に近づくほど線を薄くし、
  // 完全に透明になる内側は描画自体から外す。
  sync(
    el: OrbitalElements | null, fo: FloatingOrigin, force = false, densifyNear?: Vec3,
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

    let focusE: number | undefined;
    if (densifyNear) {
      // 要調査: 密に配置したいのは本来フローティングオリジン(fo)近傍だが、fo は微動でも
      // 動いて再生成を頻発させるため、呼び出し側は代わりに自機位置を渡している。fo からの
      // 乖離が大きい場面では密配置が実際の描画中心とずれる可能性がある。
      // densifyNear の軌道面内ローカル座標 (x, y) から離心近点角を求める
      const x = densifyNear.x * el.pHat.x + densifyNear.y * el.pHat.y + densifyNear.z * el.pHat.z;
      const y = densifyNear.x * el.qHat.x + densifyNear.y * el.qHat.y + densifyNear.z * el.qHat.z;
      const b = el.a * Math.sqrt(1 - el.e * el.e);
      focusE = Math.atan2(y / b, x / el.a + el.e);
    }

    let regenerated = false;
    if (this.needsRegen(el, force, focusE)) {
      this.regenerate(el, focusE);
      // 頂点ごとの離心近点角が組み直されたので、前回のフェードは対応先を失っている。
      this.lastExclude = null;
      regenerated = true;
    }
    this.applyFade(excludeNearBody, regenerated);
    this.applyVisible();
  }

  // 全セグメントを描く並びにインデックスを埋める(描画範囲は呼び出し側が合わせる)。
  private resetIndices(): void {
    for (let i = 0; i < POINT_COUNT; i++) {
      this.indices[i * 2] = i;
      this.indices[i * 2 + 1] = i + 1;
    }
  }

  // 頂点ごとの不透明度と、描くセグメントの選択を求め直し、Curve へ反映する。天体の現在位置を
  // 中心とする球と各線分の最近接距離を使うので、離心率が大きい軌道や粗いサンプリングでも
  // 天体の内部を通るセグメントを取りこぼさない。完全に透明な頂点を持つセグメントは描画からも
  // 外す — 加えて、天体の角半径は頂点間隔よりずっと小さいのが普通で天体はセグメントの途中に
  // 来るため、端点の不透明度だけを見ると天体の真上を通る一本を取りこぼす。両端が天体をまたぐ
  // セグメントも落とす。forcePush = 頂点位置が変わったので fade が変化していなくても
  // Curve へ再送が要る。
  private applyFade(excludeNearBody: OrbitLineExcludeNearBody | undefined, forcePush: boolean): void {
    if (!excludeNearBody) {
      this.lastExclude = null;
      if (this.fadeNeutral && !forcePush) return;
      this.fade.fill(1);
      this.resetIndices();
      this.pushToCurve(POINT_COUNT * 2);
      this.fadeNeutral = true;
      return;
    }

    // フェード帯は天体半径からその2倍までの間に張るので、天体が自身の半径に比べて十分小さく
    // しか動いていないなら、どの頂点の不透明度も実質変わらない。全頂点の走査と GPU 転送を省く。
    const prev = this.lastExclude;
    if (!forcePush && prev) {
      const dx = excludeNearBody.position.x - prev.position.x;
      const dy = excludeNearBody.position.y - prev.position.y;
      const dz = excludeNearBody.position.z - prev.position.z;
      const shift = Math.hypot(dx, dy, dz) + Math.abs(excludeNearBody.radius - prev.radius);
      if (shift < excludeNearBody.radius * FADE_SKIP_SHIFT_RATIO) return;
    }
    this.lastExclude = { position: excludeNearBody.position, radius: excludeNearBody.radius };

    let allOpaque = true;
    for (let i = 0; i <= POINT_COUNT; i++) {
      const point = {
        x: this.positions[i * 3]!,
        y: this.positions[i * 3 + 1]!,
        z: this.positions[i * 3 + 2]!,
      } as Vec3;
      this.fade[i] = pointSphereFade(point, excludeNearBody.position, excludeNearBody.radius);
      if (this.fade[i] !== 1) allOpaque = false;
    }
    let count = 0;
    for (let i = 0; i < POINT_COUNT; i++) {
      const start = {
        x: this.positions[i * 3]!, y: this.positions[i * 3 + 1]!, z: this.positions[i * 3 + 2]!,
      } as Vec3;
      const end = {
        x: this.positions[(i + 1) * 3]!, y: this.positions[(i + 1) * 3 + 1]!, z: this.positions[(i + 1) * 3 + 2]!,
      } as Vec3;
      if (segmentIntersectsSphere(start, end, excludeNearBody.position, excludeNearBody.radius)) continue;
      this.indices[count++] = i;
      this.indices[count++] = i + 1;
    }
    this.pushToCurve(count);
    this.fadeNeutral = allOpaque && count === POINT_COUNT * 2;
  }

  // 現在の positions/fade/indices を Curve へ送る。segmentIndexCount は indices の有効長。
  private pushToCurve(segmentIndexCount: number): void {
    this.curve.setVertices(this.positions, POINT_COUNT + 1, {
      fade: this.fade,
      segments: this.indices,
      segmentCount: segmentIndexCount,
    });
  }

  // 現在の要素が直近のスナップショットから許容誤差を超えて変化していれば true(要再生成)。
  private needsRegen(el: OrbitalElements, force: boolean, focusE?: number): boolean {
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
    // フォーカス位置が大きくずれたら再生成(5度以上)
    if (focusE !== undefined && s.focusE !== undefined) {
      let diff = Math.abs(focusE - s.focusE);
      while (diff > Math.PI) diff -= Math.PI * 2;
      if (Math.abs(diff) > 0.087) return true; // ~5 deg
    }
    return false;
  }

  // 軌道要素から楕円頂点を計算し直し、再生成時点のスナップショットを取る。Curve への反映は
  // 呼び出し元の applyFade がまとめて行う。
  private regenerate(el: OrbitalElements, focusE?: number): void {
    const b = el.a * Math.sqrt(1 - el.e * el.e);
    for (let i = 0; i < POINT_COUNT; i++) {
      let t = i / POINT_COUNT;
      if (focusE !== undefined) {
        // focusE 周辺に頂点を集める非線形マッピング(3次関数による歪み)
        const f = focusE / (Math.PI * 2);
        let u = t - f;
        while (u > 0.5) u -= 1;
        while (u < -0.5) u += 1;
        // u は [-0.5, 0.5]。u^3 で中心付近を密にする
        t = f + 4 * u * u * u;
      }
      const E = t * Math.PI * 2;
      const x = el.a * (Math.cos(E) - el.e);
      const y = b * Math.sin(E);
      this.positions[i * 3] = el.pHat.x * x + el.qHat.x * y;
      this.positions[i * 3 + 1] = el.pHat.y * x + el.qHat.y * y;
      this.positions[i * 3 + 2] = el.pHat.z * x + el.qHat.z * y;
    }
    // 閉路化
    this.positions[POINT_COUNT * 3] = this.positions[0]!;
    this.positions[POINT_COUNT * 3 + 1] = this.positions[1]!;
    this.positions[POINT_COUNT * 3 + 2] = this.positions[2]!;
    this.snap = {
      a: el.a,
      e: el.e,
      hHat: { ...el.hHat },
      pHat: { ...el.pHat },
      focusE,
    };
    this.lastRegen = performance.now();
  }

  dispose(): void {
    this.curve.dispose();
  }
}
