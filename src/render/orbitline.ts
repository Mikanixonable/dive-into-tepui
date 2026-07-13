// 軌道楕円の表示(ゼロベース再実装)。旧実装は毎フレーム全頂点を
// 「自機相対座標」で書き直していたため、(1) osculating 要素の微小なゆらぎで
// 楕円が毎フレーム作り直されて振動して見える、(2) 大きな座標を Float32 頂点へ
// 毎フレーム再量子化することでガタつく、という 2 つの問題があった。
//
// 新実装の方針:
// - 頂点は地球中心(ECI)座標で一度だけ生成し、毎フレームは
//   line.position = -origin(フローティングオリジン補正)を動かすだけ。
//   楕円の焦点は常に地球中心に一致し、フレーム間で形が揺れない。
// - ジオメトリの再生成は軌道要素が実際に変化したとき(閾値超過)だけ行う。
//   J2 や第三体摂動による osculating 要素の微小なゆらぎでは再生成しない。
//   推力中・ノード編集中は force=true で毎フレーム追従させる。
import * as THREE from 'three/webgpu';
import { Elements } from '../physics/orbital';
import { Vec3 } from '../physics/vec3';

// 離心近点角 E で一様サンプリング(近点・遠点の両方で弧長が偏らない)。
// 1024 点なら LEO で 1 セグメント ~40km、弦の矢高 ~30cm で視認不能。
const POINT_COUNT = 1024;

// 再生成の閾値: これを超えて要素が動いたときだけ楕円を作り直す
const REGEN_MIN_INTERVAL_MS = 120; // 最短再生成間隔
const TOL_SMA = 3e-4; // 長半径の相対変化
const TOL_ECC = 3e-4; // 離心率の変化
const TOL_PLANE = Math.cos((0.12 * Math.PI) / 180); // 軌道面法線の角変化
const TOL_APSE = Math.cos((0.3 * Math.PI) / 180); // 近点方向の角変化(e が大きいときのみ)

export class OrbitLine {
  readonly line: THREE.Line;
  private readonly positions: Float32Array;
  private snap: { a: number; e: number; hHat: Vec3; pHat: Vec3 } | null = null;
  private lastRegen = 0;

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

  // 毎フレーム呼ぶ。origin = 自機の ECI 位置(フローティングオリジン)。
  // force = 要素が能動的に変化している間(推力中・ノード編集中)は true。
  update(el: Elements | null, origin: Vec3, force = false): void {
    if (!el || el.e >= 0.98 || !isFinite(el.a) || el.a <= 0) {
      this.line.visible = false;
      this.snap = null;
      return;
    }
    this.line.visible = true;
    // フローティングオリジン補正は Object3D の平行移動だけで行う
    // (頂点は地球中心座標のまま触らない)
    this.line.position.set(-origin.x, -origin.y, -origin.z);

    if (this.needsRegen(el, force)) {
      this.regenerate(el);
    }
  }

  private needsRegen(el: Elements, force: boolean): boolean {
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

  private regenerate(el: Elements): void {
    const b = el.a * Math.sqrt(1 - el.e * el.e);
    for (let i = 0; i < POINT_COUNT; i++) {
      const E = (i / POINT_COUNT) * Math.PI * 2;
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
    };
    this.lastRegen = performance.now();
  }
}
