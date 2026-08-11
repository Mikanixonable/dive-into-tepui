// THREE で折れ線(曲線)を描く機構だけを担う。頂点の解像度をどう決めるか(楕円のサンプル数、
// エルミート細分の本数)は呼び出し側の責務で、ここは仕上がった頂点列を受け取って GPU へ
// 反映するだけ。座標変換前の値も座標型(Vec3/KinematicState/…)も知らない — 受け取るのは
// 数値配列と THREE.Vector3/THREE.Quaternion のみ。
import * as THREE from 'three/webgpu';
import { attribute, float } from 'three/tsl';

export type CurveDash = { readonly dashSize: number; readonly gapSize: number };

export type CurveOptions = {
  readonly color: number | string;
  readonly opacity?: number;
  readonly renderOrder?: number;
  // 生成時に確保する頂点数の上限。バッファは生成時に1回だけ確保し、以後は差し替えない
  // (WebGPURenderer は描画対象ごとに頂点バッファの束縛をキャッシュしており、ジオメトリや
  // 属性ごと差し替えても新しい頂点は反映されない)。
  readonly maxVertices: number;
  readonly dash?: CurveDash;
  readonly perVertexFade?: boolean;
};

export type CurveVerticesOptions = {
  readonly fade?: ArrayLike<number>;
  readonly segments?: ArrayLike<number>;
  readonly segmentCount?: number;
  readonly lineDistances?: ArrayLike<number>;
};

export class Curve {
  readonly object: THREE.Object3D;
  private readonly line: THREE.LineSegments;
  private readonly geom: THREE.BufferGeometry;
  private readonly mat: THREE.Material;
  private readonly positions: Float32Array;
  private readonly indices: Uint32Array;
  private readonly maxSegments: number;
  private readonly fade: Float32Array | null;
  private readonly lineDistances: Float32Array | null;
  private vertexCount = 0;
  private wantVisible = true;

  // color/opacity/renderOrder はマテリアルと描画順、maxVertices は確保する頂点バッファの
  // 上限。dash を渡すと破線(LineDashedMaterial、頂点ごとの累積距離を setVertices の
  // lineDistances で受け取る)。perVertexFade を渡すと頂点ごとの不透明度を setVertices の
  // fade で受け取れる(TSL の opacityNode で乗算する)。両者は排他。
  constructor(opts: CurveOptions) {
    const { color, opacity = 1, renderOrder = 0, maxVertices, dash, perVertexFade } = opts;
    this.maxSegments = Math.max(0, maxVertices - 1);
    this.positions = new Float32Array(maxVertices * 3);
    this.indices = new Uint32Array(this.maxSegments * 2);
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geom.setIndex(new THREE.BufferAttribute(this.indices, 1));
    this.resetIndicesToStrip();
    this.geom.setDrawRange(0, 0);

    if (perVertexFade) {
      this.fade = new Float32Array(maxVertices).fill(1);
      this.geom.setAttribute('fade', new THREE.BufferAttribute(this.fade, 1));
    } else {
      this.fade = null;
    }

    if (dash) {
      this.lineDistances = new Float32Array(maxVertices);
      this.geom.setAttribute('lineDistance', new THREE.BufferAttribute(this.lineDistances, 1));
    } else {
      this.lineDistances = null;
    }

    if (dash) {
      this.mat = new THREE.LineDashedMaterial({
        color, transparent: true, opacity, depthWrite: false,
        dashSize: dash.dashSize, gapSize: dash.gapSize,
      });
    } else if (perVertexFade) {
      // 一様な material.opacity では頂点ごとに値を変えられないため、TSL で頂点属性 fade を
      // 読むノードマテリアルを使う。three/webgpu の公開型は LineBasicNodeMaterial を含まず
      // 暫定シムで補っているため、シム側の基底クラスが LineSegments の要求する Material と
      // 型の上では一致しない。
      const nodeMat = new THREE.LineBasicNodeMaterial({ color, transparent: true, depthWrite: false });
      nodeMat.opacityNode = attribute('fade', 'float').mul(float(opacity));
      this.mat = nodeMat as unknown as THREE.Material;
    } else {
      this.mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    }

    this.line = new THREE.LineSegments(this.geom, this.mat);
    this.line.renderOrder = renderOrder;
    this.line.visible = false;
    // setVertices はバッファへ書き込んで needsUpdate を立てるだけで外接球を更新しないので、
    // 既定のフラスタム判定が使う外接球は古いまま(初期値は全頂点ゼロ)になる。
    this.line.frustumCulled = false;
    this.object = this.line;
  }

  // 連続した折れ線(0-1, 1-2, ...)のインデックスを埋める。
  private resetIndicesToStrip(): void {
    for (let i = 0; i < this.maxSegments; i++) {
      this.indices[i * 2] = i;
      this.indices[i * 2 + 1] = i + 1;
    }
  }

  // 頂点列を書き込む。座標は描画座標系(フローティングオリジン基準)。fade/lineDistances は
  // コンストラクタで対応する属性を確保したときだけ意味を持つ。segments を省略すると
  // 連続した折れ線(0-1, 1-2, ...)として描く。
  setVertices(positions: ArrayLike<number>, vertexCount: number, opts: CurveVerticesOptions = {}): void {
    const n = Math.max(0, Math.min(vertexCount, this.positions.length / 3));
    for (let i = 0; i < n * 3; i++) this.positions[i] = positions[i]!;
    this.vertexCount = n;
    (this.geom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    if (this.fade) {
      if (opts.fade) {
        const m = Math.min(opts.fade.length, this.fade.length);
        for (let i = 0; i < m; i++) this.fade[i] = opts.fade[i]!;
        for (let i = m; i < this.fade.length; i++) this.fade[i] = 1;
      } else {
        this.fade.fill(1);
      }
      (this.geom.getAttribute('fade') as THREE.BufferAttribute).needsUpdate = true;
    }

    if (this.lineDistances) {
      if (opts.lineDistances) {
        const m = Math.min(opts.lineDistances.length, this.lineDistances.length);
        for (let i = 0; i < m; i++) this.lineDistances[i] = opts.lineDistances[i]!;
      }
      (this.geom.getAttribute('lineDistance') as THREE.BufferAttribute).needsUpdate = true;
    }

    let segmentIndexCount: number;
    if (opts.segments) {
      // 呼び出し側が選んだセグメントだけを描く(例: 天体を通るセグメントの間引き)。
      const requested = opts.segmentCount ?? opts.segments.length;
      const m = Math.min(requested, this.indices.length);
      for (let i = 0; i < m; i++) this.indices[i] = opts.segments[i]!;
      segmentIndexCount = m;
    } else {
      this.resetIndicesToStrip();
      segmentIndexCount = Math.max(0, n - 1) * 2;
    }
    (this.geom.getIndex() as THREE.BufferAttribute).needsUpdate = true;
    this.geom.setDrawRange(0, segmentIndexCount);

    this.applyVisible();
  }

  // 破線パターンを書き換える。破線でないマテリアルでは何もしない。
  setDash(dashSize: number, gapSize: number): void {
    if (this.mat instanceof THREE.LineDashedMaterial) {
      this.mat.dashSize = dashSize;
      this.mat.gapSize = gapSize;
    }
  }

  setTransform(position: THREE.Vector3, quaternion?: THREE.Quaternion): void {
    this.line.position.copy(position);
    if (quaternion) this.line.quaternion.copy(quaternion);
  }

  // 表示を要求する。頂点数が2未満の間は実際には隠れたままになる。
  setVisible(v: boolean): void {
    this.wantVisible = v;
    this.applyVisible();
  }

  get visible(): boolean {
    return this.line.visible;
  }

  // 折れ線は2点以上ないと描けないので、頂点数不足のときは表示要求に関わらず隠す。
  private applyVisible(): void {
    this.line.visible = this.wantVisible && this.vertexCount >= 2;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
