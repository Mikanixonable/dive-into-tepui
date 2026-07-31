// 軌道楕円の表示。頂点を毎フレーム「自機相対座標」で書き直す方式だと、(1) osculating
// 要素の微小なゆらぎで楕円が毎フレーム作り直されて振動して見える、(2) 大きな座標を
// Float32 頂点へ毎フレーム再量子化することでガタつく、という 2 つの問題が生じる。
// そのため:
//
// - 頂点は地球中心(ECI)座標で一度だけ生成し、毎フレームは
//   line.position = -origin(フローティングオリジン補正)を動かすだけ。
//   楕円の焦点は常に地球中心に一致し、フレーム間で形が揺れない。
// - ジオメトリの再生成は軌道要素が実際に変化したとき(閾値超過)だけ行う。
//   J2 や第三体摂動による osculating 要素の微小なゆらぎでは再生成しない。
//   推力中・ノード編集中の force=true も、最短再生成間隔 REGEN_MIN_INTERVAL_MS
//   (120ms)より短い間隔では再生成させない。
import * as THREE from 'three/webgpu';
import { Elements } from '../physics/orbital';
import { Vec3, v3 } from '../physics/vec3';
import { FloatingOrigin } from '../game/floating-origin';

// 楕円頂点は地球中心(ECI 原点)基準。line.position はその原点の描画フレーム位置。
const EARTH_CENTER = v3(0, 0, 0);

// 離心近点角 E で一様サンプリング + 自機付近を密にする非線形マッピング。
const POINT_COUNT = 2048;

// 再生成の閾値: これを超えて要素が動いたときだけ楕円を作り直す
const REGEN_MIN_INTERVAL_MS = 120; // 最短再生成間隔
const TOL_SMA = 3e-4; // 長半径の相対変化
const TOL_ECC = 3e-4; // 離心率の変化
const TOL_PLANE = Math.cos((0.12 * Math.PI) / 180); // 軌道面法線の角変化
const TOL_APSE = Math.cos((0.3 * Math.PI) / 180); // 近点方向の角変化(e が大きいときのみ)

export class OrbitLine {
  readonly line: THREE.Line;
  private readonly positions: Float32Array;
  private snap: { a: number; e: number; hHat: Vec3; pHat: Vec3; focusE?: number } | null = null;
  private lastRegen = 0;

  // バッファジオメトリと LineBasicMaterial を組み立てる。
  constructor(color: number, opacity = 0.5) {
    this.positions = new Float32Array((POINT_COUNT + 1) * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    // WebGPU レンダラー(r169)は LineLoop 非対応のため、
    // THREE.Line で始点を終端に複製して閉じる。
    this.line = new THREE.Line(geo, mat);
    this.line.frustumCulled = false;
    this.line.renderOrder = 1;
  }

  // 毎フレーム呼ぶ。fo = 描画のフローティングオリジン。
  // force = 要素が能動的に変化している間(推力中・ノード編集中)は true。
  // focusPos = 指定すると、その ECI 点の付近に頂点を密に配置する。意味論的には「高精度で
  // 描きたい点」= フローティングオリジン近傍だが、fo は微動でも動き再生成を頻発させるため、
  // 呼び出し側は妥協として自機位置を渡す(自機軌道線用途)。fo とは別引数として区別する。
  // 呼び出し側が算出した Elements を THREE.Line ジオメトリ/位置へ反映するだけの sync。
  sync(el: Elements | null, fo: FloatingOrigin, force = false, focusPos?: Vec3): void {
    if (!el || el.e >= 0.98 || !isFinite(el.a) || el.a <= 0) {
      this.line.visible = false;
      this.snap = null;
      return;
    }
    this.line.visible = true;
    // フローティングオリジン補正は Object3D の平行移動だけで行う
    // (頂点は地球中心座標のまま触らない)
    this.line.position.copy(fo.RtoThreeV3(EARTH_CENTER));

    let focusE: number | undefined;
    if (focusPos) {
      // focusPos の軌道面内ローカル座標 (x, y) から離心近点角を求める
      const x = focusPos.x * el.pHat.x + focusPos.y * el.pHat.y + focusPos.z * el.pHat.z;
      const y = focusPos.x * el.qHat.x + focusPos.y * el.qHat.y + focusPos.z * el.qHat.z;
      const b = el.a * Math.sqrt(1 - el.e * el.e);
      focusE = Math.atan2(y / b, x / el.a + el.e);
    }

    if (this.needsRegen(el, force, focusE)) {
      this.regenerate(el, focusE);
    }
  }

  // 現在の要素が直近のスナップショットから許容誤差を超えて変化していれば true(要再生成)。
  private needsRegen(el: Elements, force: boolean, focusE?: number): boolean {
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

  // 軌道要素から楕円頂点を計算し直してジオメトリへ反映し、再生成時点のスナップショットを取る。
  private regenerate(el: Elements, focusE?: number): void {
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
    (this.line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.snap = {
      a: el.a,
      e: el.e,
      hHat: { ...el.hHat },
      pHat: { ...el.pHat },
      focusE,
    };
    this.lastRegen = performance.now();
  }

  // geometry/material を破棄する。このインスタンス固有(コンストラクタで new した)ため、
  // 他の OrbitLine インスタンスと共有していない — 呼び出し後は再利用不可。
  dispose(): void {
    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
  }
}
