// THREE で折れ線(曲線)を描く機構だけを担う。頂点をどこに置くかは t∈[0,1] を評価する
// sample 関数から画面上のサジッタ・折れ角を見て自前で決める(適応分割) — 呼び出し側は
// 「t を渡すと曲線上の点が返る」関数だけを渡せばよく、それが楕円かエルミート補間かは
// 知らない。座標変換前の値も座標型(Vec3/KinematicState/…)も知らず、受け取るのは
// THREE.Vector3/THREE.Camera と数値だけ。
import * as THREE from 'three/webgpu';
import { metersPerPixelFromTanHalfFov, MIN_DEPTH } from '../physics/projection';

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
};

// t∈[0,1] の位置における曲線上の点を out へ書く。sample(0) と sample(1) が一致する(周期的
// である)なら、その曲線は自然に閉じた輪として描かれる。
export type CurveSampler = (t: number, out: THREE.Vector3) => void;

export type SetCurveOptions = {
  // 再サンプリングの要否を決める不透明な値。前回と === で異なるときだけ焼き直す — sample の
  // 中身が変わったことを表す値を呼び出し側が用意する(例: 元データの参照が変わったときだけ
  // 新しいオブジェクトを作る)。
  readonly revision: unknown;
  // 画面上のサジッタ目標を実距離に換算するための、現在の描画カメラ。
  readonly camera: THREE.Camera;
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

// カメラ視線方向の変化に対する焼き直し閾値(なす角の余弦)。適応分割は焼いた瞬間の視線方向を
// 基準に「手前だけ細かく、奥は MAX_EDGE_TURN 相当に粗く」焼くため、距離が変わらず向きだけ
// 変わる周回でも粗い区間が手前に回り込み得る。その回り込みが目立たない角度に MAX_EDGE_TURN と
// 同程度の値を採る。
const CAM_DIR_REBAKE_COS = Math.cos((5 * Math.PI) / 180);

// f32 の相対量子化幅(仮数23bit)。sample の座標系は LEO スケールの絶対座標を含みうるため、
// これをそのまま頂点バッファ(f32)へ書くと、その大きさに応じた量子化ノイズが生じ、近距離の
// カメラからは画面上のピクセル単位のずれとして見えてしまう。頂点バッファへは常にカメラ近傍の
// 基準点(pivot)からの差分だけを書き、その基準点をカメラの動きに追従させることでこれを防ぐ。
const F32_RELATIVE_EPS = 2 ** -24;

// pivot の更新を許す画面上の誤差上限 [px]。MAX_EDGE_SAG_PX(適応分割のサジッタ目標)より
// 十分小さい値にして、量子化誤差が分割の粗さに埋もれて見えなくなるようにする。
const PIVOT_MAX_ERROR_PX = 0.1;

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
  private readonly lineDistances: Float32Array | null;
  private vertexCount = 0;
  private wantVisible = true;

  // 直近に適応分割で焼いた頂点(sample が返した座標系のまま、変換前)。倍精度で持つ理由は
  // pivot 自体の精度を落とさないため — GPU へ渡す positions(f32)は常にこの配列から pivot
  // を差し引いた差分として書く。
  private readonly bakedLocal: Float64Array;
  private bakedCount = 0;
  private hasBaked = false;
  private lastRevision: unknown = undefined;
  private bakedScale: number | null = null;
  private readonly bakedCamFwd = new THREE.Vector3();

  // 頂点バッファ(f32)へ書く直前に bakedLocal の全頂点から差し引く基準点。sample が返す
  // 座標系のまま、カメラの現在位置に追従させる。
  private readonly pivot = new THREE.Vector3();
  private hasPivot = false;

  // setTransform が要求した変換そのもの(pivot 差し引き前)。line.position/quaternion は
  // pivot 分をこの変換で補って書き込むため、分割判定や pivot の追従判定など pivot に依存
  // しない計算はこちらを読む。
  private readonly reqPosition = new THREE.Vector3();
  private readonly reqQuaternion = new THREE.Quaternion();

  private readonly scratchA = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly scratchM = new THREE.Vector3();
  private readonly scratchWorld = new THREE.Vector3();
  private readonly scratchLocalCam = new THREE.Vector3();
  private readonly scratchInvQuat = new THREE.Quaternion();
  private readonly scratchPivotWorld = new THREE.Vector3();

  // setCurve の呼び出しごとに一度だけ求め直す、カメラのワールド前方向・位置・画角換算値。
  // scaleAtLocal は分割の各テストから読むだけで、自分では取得し直さない。
  private readonly camFwd = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private camTanHalfFov = 0;
  private camNear = 0;

  // 現在の初期区間に割り当てられた頂点予算(rebake がこの値までしか subdivide に積ませない)。
  private segmentBakedLimit = 0;

  // color/opacity/renderOrder はマテリアルと描画順、maxVertices は確保する頂点バッファの
  // 上限。dash を渡すと破線(LineDashedMaterial、頂点ごとの累積距離を焼く)。
  constructor(opts: CurveOptions) {
    const { color, opacity = 1, renderOrder = 0, maxVertices, dash } = opts;
    this.maxVertices = maxVertices;
    this.maxSegments = Math.max(0, maxVertices - 1);
    this.positions = new Float32Array(maxVertices * 3);
    this.bakedLocal = new Float64Array(maxVertices * 3);
    this.indices = new Uint32Array(this.maxSegments * 2);
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geom.setIndex(new THREE.BufferAttribute(this.indices, 1));
    this.resetIndicesToStrip();
    this.geom.setDrawRange(0, 0);

    if (dash) {
      this.lineDistances = new Float32Array(maxVertices);
      this.geom.setAttribute('lineDistance', new THREE.BufferAttribute(this.lineDistances, 1));
    } else {
      this.lineDistances = null;
    }

    this.mat = dash
      ? new THREE.LineDashedMaterial({
        color, transparent: true, opacity, depthWrite: false,
        dashSize: dash.dashSize, gapSize: dash.gapSize,
      })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });

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

  // 以後の scaleAtLocal が読むカメラのワールド前方向・位置・画角換算値・ニアプレーン距離を
  // 求め直す。
  private cacheCameraFrame(camera: THREE.Camera): void {
    camera.getWorldDirection(this.camFwd);
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    const fovDeg = camera instanceof THREE.PerspectiveCamera ? camera.fov : 50;
    this.camTanHalfFov = Math.tan((fovDeg * Math.PI) / 360);
    this.camNear = camera instanceof THREE.PerspectiveCamera ? camera.near : MIN_DEPTH;
  }

  // local 座標(sample が返す座標系、pivot 差し引き前)の点における m/px を返す。
  // cacheCameraFrame を先に呼んでおくこと。要求された変換(reqPosition/reqQuaternion)で
  // ワールドへ写す — pivot はカメラの動きに追従するだけの GPU バッファ上の便宜であって
  // sample→ワールドの変換そのものではないため、ここでは読まない。視点より手前の点は画面上の
  // どこにも映らないので、前方奥行きではなくカメラからの距離を尺度にする — そうしないと
  // metersPerPixelFromTanHalfFov 内の下限まで潰れ、背後に回り込んだ区間だけがサジッタ判定を
  // 常に外して頂点予算を使い切ってしまう。
  private scaleAtLocal(lx: number, ly: number, lz: number): number {
    this.scratchWorld.set(lx, ly, lz).applyQuaternion(this.reqQuaternion).add(this.reqPosition);
    const dx = this.scratchWorld.x - this.camPos.x;
    const dy = this.scratchWorld.y - this.camPos.y;
    const dz = this.scratchWorld.z - this.camPos.z;
    const depth = dx * this.camFwd.x + dy * this.camFwd.y + dz * this.camFwd.z;
    const effective = depth >= this.camNear
      ? depth
      : Math.max(this.camNear, Math.sqrt(dx * dx + dy * dy + dz * dz));
    return metersPerPixelFromTanHalfFov(this.camTanHalfFov, effective, window.innerHeight);
  }

  // 焼き直し判定と pivot の追従判定に使う代表スケール(m/px)。sample(0) 1点だけを見ると、
  // その点が視点面をまたぐ曲線で値が乱高下し、SCALE_REBAKE_RATIO を毎フレーム跨いでしまう。
  // 分割の粗さを決めるのは曲線上で最もカメラに寄っている点なので、初期分割と同じ
  // INITIAL_SEGMENTS+1 点の中の最小値を代表値とする。cacheCameraFrame を先に呼んでおくこと。
  private representativeScale(sample: CurveSampler): number {
    let minScale = Infinity;
    for (let i = 0; i <= INITIAL_SEGMENTS; i++) {
      sample(i / INITIAL_SEGMENTS, this.scratchA);
      const s = this.scaleAtLocal(this.scratchA.x, this.scratchA.y, this.scratchA.z);
      if (s < minScale) minScale = s;
    }
    return minScale;
  }

  // カメラのワールド位置(cacheCameraFrame 済みの camPos)を、要求された変換の逆で sample の
  // 座標系へ戻す。pivot をカメラ近傍に据えるための基準点として使う。
  private localCameraPos(out: THREE.Vector3): THREE.Vector3 {
    this.scratchInvQuat.copy(this.reqQuaternion).invert();
    return out.copy(this.camPos).sub(this.reqPosition).applyQuaternion(this.scratchInvQuat);
  }

  // pivot 込みの実際の position/quaternion を line へ書き込む。要求された変換
  // (reqPosition/reqQuaternion)と現在の pivot からいつでも導出し直せる。
  private applyTransform(): void {
    this.line.quaternion.copy(this.reqQuaternion);
    this.scratchPivotWorld.copy(this.pivot).applyQuaternion(this.reqQuaternion);
    this.line.position.copy(this.reqPosition).add(this.scratchPivotWorld);
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
    if (this.bakedCount + 1 >= this.segmentBakedLimit || depth >= MAX_SUBDIVIDE_DEPTH) {
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

  // 頂点予算を INITIAL_SEGMENTS 個の初期区間へ均等割りしてから各区間を適応分割する。分割は
  // 深さ優先で、積めなかった頂点は落ちるだけなので、割り当てずに進めると先頭側の区間が予算を
  // 使い切って以降の区間が1頂点も積めない。均等割りにすることで、予算が尽きても曲線全体が
  // 一様に粗くなるだけになる(使い残しは残り区間数で割り直されるぶん後続へ回る)。
  private rebake(sample: CurveSampler): void {
    this.bakedCount = 0;
    sample(0, this.scratchA);
    this.pushBaked(this.scratchA.x, this.scratchA.y, this.scratchA.z);
    let t0 = 0, x0 = this.scratchA.x, y0 = this.scratchA.y, z0 = this.scratchA.z;
    for (let i = 1; i <= INITIAL_SEGMENTS; i++) {
      const remainingSegments = INITIAL_SEGMENTS - i + 1;
      this.segmentBakedLimit = this.bakedCount
        + Math.floor((this.maxVertices - this.bakedCount) / remainingSegments);
      const t1 = i / INITIAL_SEGMENTS;
      sample(t1, this.scratchB);
      this.subdivide(t0, x0, y0, z0, t1, this.scratchB.x, this.scratchB.y, this.scratchB.z, 0, sample);
      t0 = t1; x0 = this.scratchB.x; y0 = this.scratchB.y; z0 = this.scratchB.z;
    }
  }

  // 曲線を(必要なら)焼き直し、GPU バッファへ反映する。revision・画面スケール・カメラ視線
  // 方向のいずれも前回と実質同じであれば焼き直しも GPU への再アップロードも省く。
  setCurve(sample: CurveSampler, opts: SetCurveOptions): void {
    const { revision, camera } = opts;
    this.cacheCameraFrame(camera);
    const scaleNow = this.representativeScale(sample);
    const scaleChanged = this.bakedScale === null
      || scaleNow / this.bakedScale > SCALE_REBAKE_RATIO || this.bakedScale / scaleNow > SCALE_REBAKE_RATIO;
    const camDirChanged = this.camFwd.dot(this.bakedCamFwd) < CAM_DIR_REBAKE_COS;
    const revisionChanged = !this.hasBaked || revision !== this.lastRevision;
    const rebaked = revisionChanged || scaleChanged || camDirChanged;

    if (rebaked) {
      this.rebake(sample);
      this.hasBaked = true;
      this.lastRevision = revision;
      this.bakedScale = scaleNow;
      this.bakedCamFwd.copy(this.camFwd);
    }

    // pivot はカメラ近傍に据え続ける基準点。焼き直した頂点はまだ pivot 差し引き後の
    // positions へ反映されていないので rebake 時は必ず据え直し、それ以外は量子化誤差が
    // 画面上で無視できなくなったとき(カメラが pivot から離れたとき)だけ据え直す。
    const localCam = this.localCameraPos(this.scratchLocalCam);
    let pivotChanged = rebaked || !this.hasPivot;
    if (!pivotChanged) {
      const drift = localCam.distanceTo(this.pivot);
      pivotChanged = (drift * F32_RELATIVE_EPS) / scaleNow > PIVOT_MAX_ERROR_PX;
    }
    if (pivotChanged) {
      this.pivot.copy(localCam);
      this.hasPivot = true;
      this.applyTransform();
    }

    if (!rebaked && !pivotChanged) return;
    this.writePositions();
  }

  // 焼いた頂点(pivot 差し引き後)と全セグメントの描画範囲を GPU へ反映する。
  private writePositions(): void {
    const n = this.bakedCount;
    const { x: px, y: py, z: pz } = this.pivot;
    for (let i = 0; i < n; i++) {
      this.positions[i * 3] = this.bakedLocal[i * 3]! - px;
      this.positions[i * 3 + 1] = this.bakedLocal[i * 3 + 1]! - py;
      this.positions[i * 3 + 2] = this.bakedLocal[i * 3 + 2]! - pz;
    }
    this.vertexCount = n;
    (this.geom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.writeLineDistances(n);
    this.resetIndicesToStrip();
    const segmentIndexCount = Math.max(0, n - 1) * 2;
    (this.geom.getIndex() as THREE.BufferAttribute).needsUpdate = true;
    this.geom.setDrawRange(0, segmentIndexCount);
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

  // 曲線を持たない状態へ戻す。表示要求に関わらず何も描かれなくなる。
  clear(): void {
    this.bakedCount = 0;
    this.vertexCount = 0;
    this.hasBaked = false;
    this.bakedScale = null;
    this.lastRevision = undefined;
    this.geom.setDrawRange(0, 0);
    this.applyVisible();
  }

  // 破線パターンを書き換える。破線でないマテリアルでは何もしない。
  setDash(dashSize: number, gapSize: number): void {
    if (this.mat instanceof THREE.LineDashedMaterial) {
      this.mat.dashSize = dashSize;
      this.mat.gapSize = gapSize;
    }
  }

  // マテリアルの不透明度を書き換える。
  setOpacity(opacity: number): void {
    this.mat.opacity = opacity;
  }

  // マテリアルを作り直さず色だけ更新する。テーマ切替時も GPU の頂点バッファを維持できる。
  setColor(color: THREE.ColorRepresentation): void {
    const material = this.mat as THREE.LineBasicMaterial | THREE.LineDashedMaterial;
    material.color.set(color);
    material.needsUpdate = true;
  }

  // sample の座標系をワールドへ写す変換を渡す。実際に line へ書く position/quaternion は
  // pivot 分の補正を経るため、渡した値がそのまま line.position/quaternion にはならない。
  setTransform(position: THREE.Vector3, quaternion?: THREE.Quaternion): void {
    this.reqPosition.copy(position);
    if (quaternion) this.reqQuaternion.copy(quaternion);
    this.applyTransform();
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
