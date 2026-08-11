// THREE で折れ線(曲線)を描く機構だけを担う。頂点をどこに置くかは t∈[0,1] を評価する
// sample 関数から画面上のサジッタ・折れ角を見て自前で決める(適応分割) — 呼び出し側は
// 「t を渡すと曲線上の点が返る」関数だけを渡せばよく、それが楕円かエルミート補間かは
// 知らない。座標変換前の値も座標型(Vec3/KinematicState/…)も知らず、受け取るのは
// THREE.Vector3/THREE.Camera と数値だけ。
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

// t∈[0,1] の位置における曲線上の点を out へ書く。sample(0) と sample(1) が一致する(周期的
// である)なら、その曲線は自然に閉じた輪として描かれる。
export type CurveSampler = (t: number, out: THREE.Vector3) => void;

// この球に近い頂点ほど透明にし、球を貫くセグメントは描画自体から外す。center は sample が
// 返す点と同じ座標系。天体の自転や公転で球が動く場合、呼び出し側は毎フレーム新しい値を渡してよい
// (曲線自体の再サンプリングとは独立に、動いた分だけフェードを引き直す)。
export type CurveExcludeSphere = { readonly center: THREE.Vector3; readonly radius: number };

export type SetCurveOptions = {
  // 再サンプリングの要否を決める不透明な値。前回と === で異なるときだけ焼き直す — sample の
  // 中身が変わったことを表す値を呼び出し側が用意する(例: 元データの参照が変わったときだけ
  // 新しいオブジェクトを作る)。
  readonly revision: unknown;
  // 画面上のサジッタ目標を実距離に換算するための、現在の描画カメラ。
  readonly camera: THREE.Camera;
  readonly excludeSphere?: CurveExcludeSphere;
};

// 弦に対する曲線の膨らみ(サジッタ)の目標値 [px]。画面上のサジッタをこの値以下に抑える
// ように分割する。世界空間の許容量を固定にすると、寄るほど画面上のずれが線形に増えてしまう
// (ズームに連動しない歯止めはこの後の MAX_EDGE_TURN が担う)。
const MAX_EDGE_SAG_PX = 0.5;

// 1辺あたりに許す折れ角の上限。サジッタ目標だけに従うと、遠ズームで1区間が際限なく粗くなる
// (画面上のサジッタが縮まないぶん実距離の許容量が際限なく伸びる)ため、その歯止めとして残す。
const MAX_EDGE_TURN = (5 * Math.PI) / 180;

// 初期分割数。閉曲線を1区間のまま評価すると t=0/1 が同一点で弦が縮退するため、最低限これだけ
// 分けてから適応分割に入る。開曲線でも同じ数から始めて構わない(以後の分割で細部は拾われる)。
const INITIAL_SEGMENTS = 8;

// 適応分割の再帰深さの上限。頂点予算(maxVertices)よりずっと余裕を持たせた安全弁で、
// 通常は予算の方が先に効く。
const MAX_SUBDIVIDE_DEPTH = 24;

// スケール変化に対する焼き直し抑制の遊び幅。毎フレームの微小なズーム変化のたびに
// 焼き直さないための遊び。
const SCALE_REBAKE_RATIO = 1.2;

// フェードの再計算を省く excludeSphere の移動量。球の半径に対するこの割合より小さく
// 動いただけなら、フェード帯の中の各頂点の不透明度は視認できるほど変わらない。
const EXCLUDE_SKIP_SHIFT_RATIO = 1 / 16;

const MIN_DEPTH = 1e-6;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// 点 p から線分 ab への最短距離の2乗。
function distanceSqPointToSegment(
  px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number,
): number {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const lenSq = dx * dx + dy * dy + dz * dz;
  if (lenSq <= 0) {
    const ex = px - ax, ey = py - ay, ez = pz - az;
    return ex * ex + ey * ey + ez * ez;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / lenSq));
  const cx = ax + dx * t, cy = ay + dy * t, cz = az + dz * t;
  const ex = px - cx, ey = py - cy, ez = pz - cz;
  return ex * ex + ey * ey + ez * ez;
}

export class Curve {
  readonly object: THREE.Object3D;
  private readonly line: THREE.LineSegments;
  private readonly geom: THREE.BufferGeometry;
  private readonly mat: THREE.Material;
  private readonly positions: Float32Array;
  private readonly indices: Uint32Array;
  private readonly maxVertices: number;
  private readonly maxSegments: number;
  private readonly fade: Float32Array | null;
  private readonly lineDistances: Float32Array | null;
  private vertexCount = 0;
  private wantVisible = true;

  // 直近に適応分割で焼いた頂点(sample が返した座標系のまま、変換前)。excludeSphere だけが
  // 変わったフレームで曲線を再サンプリングせずにフェードだけ引き直せるよう保持する。
  private readonly bakedLocal: Float32Array;
  private bakedCount = 0;
  private hasBaked = false;
  private lastRevision: unknown = undefined;
  private bakedScale: number | null = null;
  private readonly lastExcludeCenter = new THREE.Vector3();
  private hasExcludeCenter = false;
  private lastExcludeRadius = 0;
  private fadeNeutral = true;

  private readonly scratchA = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly scratchM = new THREE.Vector3();
  private readonly scratchWorld = new THREE.Vector3();

  // setCurve の呼び出しごとに一度だけ求め直す、カメラのワールド前方向・位置・画角換算値。
  // scaleAtLocal は分割の各テストから読むだけで、自分では取得し直さない。
  private readonly camFwd = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private camTanHalfFov = 0;

  // color/opacity/renderOrder はマテリアルと描画順、maxVertices は確保する頂点バッファの
  // 上限。dash を渡すと破線(LineDashedMaterial、頂点ごとの累積距離を焼く)。perVertexFade
  // を渡すと頂点ごとの不透明度を持てる(excludeSphere の指定に使う、TSL の opacityNode で
  // 乗算する)。両者は排他。
  constructor(opts: CurveOptions) {
    const { color, opacity = 1, renderOrder = 0, maxVertices, dash, perVertexFade } = opts;
    this.maxVertices = maxVertices;
    this.maxSegments = Math.max(0, maxVertices - 1);
    this.positions = new Float32Array(maxVertices * 3);
    this.bakedLocal = new Float32Array(maxVertices * 3);
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
    // 頂点はバッファへ書き込んで needsUpdate を立てるだけで外接球を更新しないので、
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

  // 以後の scaleAtLocal が読むカメラのワールド前方向・位置・画角換算値を求め直す。
  private cacheCameraFrame(camera: THREE.Camera): void {
    camera.getWorldDirection(this.camFwd);
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    const fovDeg = camera instanceof THREE.PerspectiveCamera ? camera.fov : 50;
    this.camTanHalfFov = Math.tan((fovDeg * Math.PI) / 360);
  }

  // local 座標(this.line の現在の position/quaternion 系)の点における m/px を返す。
  // cacheCameraFrame を先に呼んでおくこと。
  private scaleAtLocal(lx: number, ly: number, lz: number): number {
    this.scratchWorld.set(lx, ly, lz).applyQuaternion(this.line.quaternion).add(this.line.position);
    const dx = this.scratchWorld.x - this.camPos.x;
    const dy = this.scratchWorld.y - this.camPos.y;
    const dz = this.scratchWorld.z - this.camPos.z;
    const depth = Math.max(MIN_DEPTH, dx * this.camFwd.x + dy * this.camFwd.y + dz * this.camFwd.z);
    return (2 * depth * this.camTanHalfFov) / window.innerHeight;
  }

  private pushBaked(x: number, y: number, z: number): void {
    if (this.bakedCount >= this.maxVertices) return;
    const i = this.bakedCount * 3;
    this.bakedLocal[i] = x;
    this.bakedLocal[i + 1] = y;
    this.bakedLocal[i + 2] = z;
    this.bakedCount++;
  }

  // 区間 [t0,(x0,y0,z0)] → [t1,(x1,y1,z1)] を、画面上のサジッタ・折れ角が閾値を下回るまで
  // 再帰的に二分する。左端は呼び出し側が既に積んでいるので、ここでは右端だけを積む。
  private subdivide(
    t0: number, x0: number, y0: number, z0: number,
    t1: number, x1: number, y1: number, z1: number,
    depth: number, sample: CurveSampler,
  ): void {
    if (this.bakedCount + 1 >= this.maxVertices || depth >= MAX_SUBDIVIDE_DEPTH) {
      this.pushBaked(x1, y1, z1);
      return;
    }
    const tm = (t0 + t1) / 2;
    sample(tm, this.scratchM);
    const mx = this.scratchM.x, my = this.scratchM.y, mz = this.scratchM.z;

    const sagSq = distanceSqPointToSegment(mx, my, mz, x0, y0, z0, x1, y1, z1);
    const mpp = this.scaleAtLocal(mx, my, mz);
    const sagittaPx = mpp > 0 ? Math.sqrt(sagSq) / mpp : 0;

    const ax = mx - x0, ay = my - y0, az = mz - z0;
    const bx = x1 - mx, by = y1 - my, bz = z1 - mz;
    const aLen = Math.hypot(ax, ay, az), bLen = Math.hypot(bx, by, bz);
    const turn = aLen > 0 && bLen > 0
      ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (aLen * bLen))))
      : 0;

    if (sagittaPx > MAX_EDGE_SAG_PX || turn > MAX_EDGE_TURN) {
      this.subdivide(t0, x0, y0, z0, tm, mx, my, mz, depth + 1, sample);
      this.subdivide(tm, mx, my, mz, t1, x1, y1, z1, depth + 1, sample);
    } else {
      this.pushBaked(x1, y1, z1);
    }
  }

  private rebake(sample: CurveSampler): void {
    this.bakedCount = 0;
    sample(0, this.scratchA);
    this.pushBaked(this.scratchA.x, this.scratchA.y, this.scratchA.z);
    let t0 = 0, x0 = this.scratchA.x, y0 = this.scratchA.y, z0 = this.scratchA.z;
    for (let i = 1; i <= INITIAL_SEGMENTS; i++) {
      const t1 = i / INITIAL_SEGMENTS;
      sample(t1, this.scratchB);
      this.subdivide(t0, x0, y0, z0, t1, this.scratchB.x, this.scratchB.y, this.scratchB.z, 0, sample);
      t0 = t1; x0 = this.scratchB.x; y0 = this.scratchB.y; z0 = this.scratchB.z;
    }
  }

  // 曲線を(必要なら)焼き直し、GPU バッファへ反映する。revision・画面スケールのどちらも
  // 前回と実質同じであれば焼き直しを省く。excludeSphere だけが変化した場合は曲線の形状は
  // 変えず、頂点ごとの不透明度と描くセグメントの選択だけを引き直す。
  setCurve(sample: CurveSampler, opts: SetCurveOptions): void {
    const { revision, camera, excludeSphere } = opts;
    this.cacheCameraFrame(camera);
    sample(0, this.scratchA);
    const scaleNow = this.scaleAtLocal(this.scratchA.x, this.scratchA.y, this.scratchA.z);
    const scaleChanged = this.bakedScale === null
      || scaleNow / this.bakedScale > SCALE_REBAKE_RATIO || this.bakedScale / scaleNow > SCALE_REBAKE_RATIO;
    const revisionChanged = !this.hasBaked || revision !== this.lastRevision;
    const rebaked = revisionChanged || scaleChanged;

    if (rebaked) {
      this.rebake(sample);
      this.hasBaked = true;
      this.lastRevision = revision;
      this.bakedScale = scaleNow;
      this.hasExcludeCenter = false; // 頂点が入れ替わったので直前のフェードは対応先を失っている
    }

    if (!excludeSphere) {
      if (!rebaked && !this.hasExcludeCenter && this.fadeNeutral) return;
      this.hasExcludeCenter = false;
      this.writeNeutral();
      return;
    }

    if (!rebaked && this.hasExcludeCenter) {
      const shift = this.lastExcludeCenter.distanceTo(excludeSphere.center)
        + Math.abs(excludeSphere.radius - this.lastExcludeRadius);
      if (shift < excludeSphere.radius * EXCLUDE_SKIP_SHIFT_RATIO) return;
    }
    this.writeExcluded(excludeSphere);
    this.lastExcludeCenter.copy(excludeSphere.center);
    this.hasExcludeCenter = true;
    this.lastExcludeRadius = excludeSphere.radius;
  }

  // フェード無し・全セグメントの状態を GPU へ反映する。
  private writeNeutral(): void {
    const n = this.bakedCount;
    for (let i = 0; i < n * 3; i++) this.positions[i] = this.bakedLocal[i]!;
    this.vertexCount = n;
    (this.geom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    if (this.fade) {
      this.fade.fill(1);
      (this.geom.getAttribute('fade') as THREE.BufferAttribute).needsUpdate = true;
    }
    this.writeLineDistances(n);
    this.resetIndicesToStrip();
    const segmentIndexCount = Math.max(0, n - 1) * 2;
    (this.geom.getIndex() as THREE.BufferAttribute).needsUpdate = true;
    this.geom.setDrawRange(0, segmentIndexCount);
    this.fadeNeutral = true;
    this.applyVisible();
  }

  // 頂点ごとの不透明度と、球を貫くセグメントの除外を求め直して GPU へ反映する。端点だけを
  // 見ると、天体の角半径が頂点間隔よりずっと小さい場合に天体の真上を通る1本を取りこぼす
  // ため、線分と球の最近接距離で判定する。
  private writeExcluded(exclude: CurveExcludeSphere): void {
    const n = this.bakedCount;
    for (let i = 0; i < n * 3; i++) this.positions[i] = this.bakedLocal[i]!;
    this.vertexCount = n;
    (this.geom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    const { center, radius } = exclude;
    let allOpaque = true;
    if (this.fade) {
      for (let i = 0; i < n; i++) {
        const dx = this.bakedLocal[i * 3]! - center.x;
        const dy = this.bakedLocal[i * 3 + 1]! - center.y;
        const dz = this.bakedLocal[i * 3 + 2]! - center.z;
        const v = radius > 0 ? smoothstep(radius, radius * 2, Math.hypot(dx, dy, dz)) : 1;
        this.fade[i] = v;
        if (v !== 1) allOpaque = false;
      }
      (this.geom.getAttribute('fade') as THREE.BufferAttribute).needsUpdate = true;
    }

    let count = 0;
    const radiusSq = radius * radius;
    for (let i = 0; i < n - 1; i++) {
      const ax = this.bakedLocal[i * 3]!, ay = this.bakedLocal[i * 3 + 1]!, az = this.bakedLocal[i * 3 + 2]!;
      const bx = this.bakedLocal[(i + 1) * 3]!, by = this.bakedLocal[(i + 1) * 3 + 1]!, bz = this.bakedLocal[(i + 1) * 3 + 2]!;
      if (radius > 0 && distanceSqPointToSegment(center.x, center.y, center.z, ax, ay, az, bx, by, bz) <= radiusSq) continue;
      this.indices[count++] = i;
      this.indices[count++] = i + 1;
    }
    this.writeLineDistances(n);
    (this.geom.getIndex() as THREE.BufferAttribute).needsUpdate = true;
    this.geom.setDrawRange(0, count);
    this.fadeNeutral = allOpaque && count === Math.max(0, n - 1) * 2;
    this.applyVisible();
  }

  // 破線用の始点からの累積距離を焼く(破線でない構築なら何もしない)。
  private writeLineDistances(n: number): void {
    if (!this.lineDistances) return;
    let dist = 0;
    this.lineDistances[0] = 0;
    for (let i = 1; i < n; i++) {
      const dx = this.bakedLocal[i * 3]! - this.bakedLocal[(i - 1) * 3]!;
      const dy = this.bakedLocal[i * 3 + 1]! - this.bakedLocal[(i - 1) * 3 + 1]!;
      const dz = this.bakedLocal[i * 3 + 2]! - this.bakedLocal[(i - 1) * 3 + 2]!;
      dist += Math.hypot(dx, dy, dz);
      this.lineDistances[i] = dist;
    }
    (this.geom.getAttribute('lineDistance') as THREE.BufferAttribute).needsUpdate = true;
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
