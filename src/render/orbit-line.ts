// OrbitalElements から軌道楕円を描画する。頂点は中心天体(OrbitalElements.center)相対座標のまま保持し、
// フローティングオリジンによる Object3D 平行移動でその天体の ECI 位置へ置く。どの天体を
// 中心に描くかは OrbitalElements 自身が持つため、呼び出し側が外側で選び直すことはできない。
// ジオメトリの再生成は軌道要素が閾値を超えて変化したときだけ行う。
import * as THREE from 'three/webgpu';
import { attribute, float } from 'three/tsl';
import { OrbitalElements } from '../physics/elements';
import { Vec3 } from '../physics/vec3';
import { FloatingOrigin } from '../game/floating-origin';

// 離心近点角 E で一様サンプリング + 自機付近を密にする非線形マッピング。
const POINT_COUNT = 2048;

// 再生成の閾値: これを超えて要素が動いたときだけ楕円を作り直す
const REGEN_MIN_INTERVAL_MS = 120; // 最短再生成間隔
const TOL_SMA = 3e-4; // 長半径の相対変化
const TOL_ECC = 3e-4; // 離心率の変化
const TOL_PLANE = Math.cos((0.12 * Math.PI) / 180); // 軌道面法線の角変化
const TOL_APSE = Math.cos((0.3 * Math.PI) / 180); // 近点方向の角変化(e が大きいときのみ)

// フェード帯の境界。天体中心からの距離を天体半径で割った比が、この下限以下で完全透明、
// 上限以上で完全不透明になる。
const FADE_TRANSPARENT_RADIUS_RATIO = 1;
const FADE_OPAQUE_RADIUS_RATIO = 2;

// この楕円上に乗っている天体(参照軌道線が表す天体そのもの)。E は軌道要素と同じ時刻での
// 離心近点角 [rad](2π を法として扱うので値域は問わない)、radius は物理半径 [m]。
export interface OrbitLineExcludeNearBody {
  readonly E: number;
  readonly radius: number;
}

// 角度 a の b からの符号付き差を [-π, π] で返す。
function signedAngularDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// smoothstep(edge0, edge1, x)。区間の外側は 0/1 にクランプする。
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class OrbitLine {
  readonly line: THREE.Line;
  private readonly positions: Float32Array;
  private readonly eAtIndex: Float32Array;
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
    this.line.visible = this.displayEnabled && !this.suppressed && this.snap !== null;
  }

  // バッファジオメトリと LineBasicNodeMaterial を組み立てる。
  constructor(color: string | number, opacity = 0.5) {
    this.positions = new Float32Array((POINT_COUNT + 1) * 3);
    this.eAtIndex = new Float32Array(POINT_COUNT + 1);
    this.indices = new Uint32Array(POINT_COUNT * 2);
    this.fade = new Float32Array(POINT_COUNT + 1).fill(1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('fade', new THREE.BufferAttribute(this.fade, 1));
    geo.setIndex(new THREE.BufferAttribute(this.indices, 1));
    this.resetIndices();
    geo.setDrawRange(0, POINT_COUNT * 2);
    const mat = new THREE.LineBasicNodeMaterial({
      color,
      transparent: true,
      depthWrite: false,
    });
    // 頂点属性 fade を不透明度に掛ける。一様な material.opacity では頂点ごとに
    // 値を変えられないため、TSL で頂点属性を読むノードマテリアルを使う。
    mat.opacityNode = attribute('fade', 'float').mul(float(opacity));
    // WebGPU レンダラー(r169)は LineLoop 非対応のため、閉路は始点=終端の頂点複製で作る。
    // excludeNearBody で天体近傍のセグメントを間引けるよう連続ストリップではなく
    // セグメント単位の LineSegments + インデックスバッファで描く。
    // three/webgpu の公開型は LineBasicNodeMaterial を含まず暫定シムで補っているため、
    // シム側の基底クラスが LineSegments の要求する Material と型の上では一致しない。
    this.line = new THREE.LineSegments(geo, mat as unknown as THREE.Material);
    this.line.frustumCulled = false;
    // 既定値(自機の軌道線を想定)。他ロール(ターゲット等)は呼び出し側が
    // renderOrder を上書きし、重なったときに手前へ来る優先順位を決める。
    this.line.renderOrder = 1;
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
    this.line.position.copy(fo.RtoThreeV3(el.center.state.r));
    this.nudgeTransformForGpuUpload();

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

    if (this.needsRegen(el, force, focusE)) {
      this.regenerate(el, focusE);
    }
    this.applyFade(el, excludeNearBody);
    this.applyVisible();
  }

  // 原点が厳密に静止しているフレームでも Transform を更新させるため、位置へ微小なジッターを
  // 加える。three.js r169 の WebGPURenderer は position が完全に不変だと needsUpdate を
  // 立てた頂点バッファを GPU へ送らないことがあるための回避策。
  private nudgeTransformForGpuUpload(): void {
    const p = this.line.position;
    if (p.x !== 0 || p.y !== 0 || p.z !== 0) return;
    p.x += (Math.random() - 0.5) * 1e-10;
    p.y += (Math.random() - 0.5) * 1e-10;
    p.z += (Math.random() - 0.5) * 1e-10;
  }

  // 全セグメントを描く並びにインデックスを埋める(描画範囲は呼び出し側が合わせる)。
  private resetIndices(): void {
    for (let i = 0; i < POINT_COUNT; i++) {
      this.indices[i * 2] = i;
      this.indices[i * 2 + 1] = i + 1;
    }
  }

  // 頂点ごとの不透明度と、描くセグメントの選択を求め直す。頂点位置は動かさず eAtIndex を
  // 読むだけなので、天体が軌道上を動くぶんには regenerate を伴わず毎フレーム追随できる。
  // 完全に透明な頂点を持つセグメントは描画からも外す — 加えて、天体の角半径は頂点間隔より
  // ずっと小さいのが普通で天体はセグメントの途中に来るため、端点の不透明度だけを見ると
  // 天体の真上を通る一本を取りこぼす。両端が天体をまたぐセグメントも落とす。
  private applyFade(el: OrbitalElements, excludeNearBody?: OrbitLineExcludeNearBody): void {
    const fadeAttr = this.line.geometry.getAttribute('fade') as THREE.BufferAttribute;
    const indexAttr = this.line.geometry.getIndex() as THREE.BufferAttribute;
    if (!excludeNearBody) {
      this.lastExclude = null;
      if (this.fadeNeutral) return;
      this.fade.fill(1);
      this.resetIndices();
      this.line.geometry.setDrawRange(0, POINT_COUNT * 2);
      fadeAttr.needsUpdate = true;
      indexAttr.needsUpdate = true;
      this.fadeNeutral = true;
      return;
    }

    // 天体中心からの弧長を天体半径で割った比。天体が軌道に沿って占める角度は、その半径を
    // 軌道長半径で割った値で近似できる。
    const radiiPerRadian = el.a / excludeNearBody.radius;
    // フェード帯の境界が頂点間隔ぶんも動かないなら、頂点でしか標本化しない不透明度は
    // どこも変わらないので計算も転送も省く。境界の移動量は E の変化そのものと、半径の変化が
    // 帯の外端(FADE_OPAQUE_RADIUS_RATIO)を動かす量の和で見る。
    const vertexSpacingE = (Math.PI * 2) / POINT_COUNT;
    const prev = this.lastExclude;
    if (prev) {
      const shift = Math.abs(signedAngularDiff(excludeNearBody.E, prev.E))
        + (FADE_OPAQUE_RADIUS_RATIO * Math.abs(excludeNearBody.radius - prev.radius)) / el.a;
      if (shift < vertexSpacingE) return;
    }
    this.lastExclude = { E: excludeNearBody.E, radius: excludeNearBody.radius };

    let allOpaque = true;
    for (let i = 0; i <= POINT_COUNT; i++) {
      const ratio = Math.abs(signedAngularDiff(this.eAtIndex[i]!, excludeNearBody.E)) * radiiPerRadian;
      this.fade[i] = smoothstep(FADE_TRANSPARENT_RADIUS_RATIO, FADE_OPAQUE_RADIUS_RATIO, ratio);
      if (this.fade[i] !== 1) allOpaque = false;
    }
    let count = 0;
    for (let i = 0; i < POINT_COUNT; i++) {
      if (this.fade[i] === 0 || this.fade[i + 1] === 0) continue;
      const d0 = signedAngularDiff(this.eAtIndex[i]!, excludeNearBody.E);
      const d1 = signedAngularDiff(this.eAtIndex[i + 1]!, excludeNearBody.E);
      if (Math.abs(d0) < Math.PI / 2 && Math.abs(d1) < Math.PI / 2 && d0 * d1 <= 0) continue;
      this.indices[count++] = i;
      this.indices[count++] = i + 1;
    }
    fadeAttr.needsUpdate = true;
    indexAttr.needsUpdate = true;
    this.line.geometry.setDrawRange(0, count);
    this.fadeNeutral = allOpaque && count === POINT_COUNT * 2;
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

  // 軌道要素から楕円頂点を計算し直してジオメトリへ反映し、再生成時点のスナップショットを取る。
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
      this.eAtIndex[i] = E;
      const x = el.a * (Math.cos(E) - el.e);
      const y = b * Math.sin(E);
      this.positions[i * 3] = el.pHat.x * x + el.qHat.x * y;
      this.positions[i * 3 + 1] = el.pHat.y * x + el.qHat.y * y;
      this.positions[i * 3 + 2] = el.pHat.z * x + el.qHat.z * y;
    }
    // 閉路化
    this.eAtIndex[POINT_COUNT] = this.eAtIndex[0]!;
    this.positions[POINT_COUNT * 3] = this.positions[0]!;
    this.positions[POINT_COUNT * 3 + 1] = this.positions[1]!;
    this.positions[POINT_COUNT * 3 + 2] = this.positions[2]!;
    (this.line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.line.geometry.computeBoundingSphere();
    this.line.geometry.computeBoundingBox();
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
