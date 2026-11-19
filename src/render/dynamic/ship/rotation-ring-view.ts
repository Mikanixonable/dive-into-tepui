// 建造で選択したモジュールの回転リング。接続軸まわりの円と両回りの矢印を描き、
// ドラッグ中は回した角度の弧と、離したときに適用される 90° 単位の位置を示す。
// 船体に隠れても消えないよう深度判定をしない。
import * as THREE from 'three/webgpu';
import { qNormalize, type Quat } from '../../../math/quat';
import type { Vec3 } from '../../../math/vec3';
import { markOverlay } from '../../pipeline/lit-layer';

// 選択の強調色(ship-module-view の強調語彙の selected と同じ色)。
const RING_COLOR = 0xffc85c;
const RING_SEGMENTS = 96;
const RING_OPACITY = 0.7;
const DRAG_OPACITY = 0.95;
const ARC_VERTICES = 128;
// 矢印の羽の寸法(単位円空間)。羽は接線方向へ開く角 [rad] と長さ。
const ARROW_BARB_ANGLE = 0.65;
const ARROW_BARB_LENGTH = 0.16;
// スナップ位置を示す放射線の内側・外側の半径(単位円空間)。
const SNAP_SPOKE_INNER = 0.8;
const SNAP_SPOKE_OUTER = 1.12;
// 弧が跨いだ 90° ごとに刻む目盛りの内側・外側の半径と、描ける本数の上限。
const STEP_TICK_INNER = 0.92;
const STEP_TICK_OUTER = 1.08;
const MAX_STEP_TICKS = 12;

// ドラッグ中の回転の強調。startAngle は掴んだ点の基準角、angle は掴んだ点からの
// 累積角 [rad](リングの局所 +Z まわりに右手則)。appliedSteps はいま離したときに
// 適用される 90° 単位の段数で、弧の長さとは独立に受け取る。
interface RotationRingDrag {
  readonly startAngle: number;
  readonly angle: number;
  readonly appliedSteps: number;
}

// 回転リング1つぶんの宣言。position/rotation/radius は表示座標。
interface RotationRingDisplay {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly radius: number;
  readonly drag: RotationRingDrag | null;
}

// 宣言を毎フレーム受けてリング・矢印・弧を同期する。弧の頂点は予め確保した
// バッファを書き換えて渡し、ラインループは端点を閉じて持たせる。
export class RotationRingView {
  public readonly object = new THREE.Group();
  private readonly ringGeometry = buildRingGeometry();
  private readonly arrowsGeometry = buildArrowsGeometry();
  private readonly arcGeometry = buildArcGeometry();
  private readonly spokeGeometry = buildSpokeGeometry();
  private readonly ticksGeometry = buildTicksGeometry();
  private readonly ringMaterial = ringMaterial(RING_OPACITY);
  private readonly dragMaterial = ringMaterial(DRAG_OPACITY);
  private readonly arrows: THREE.LineSegments;
  private readonly arc: THREE.Line;
  private readonly ticks: THREE.LineSegments;
  private readonly spoke = new THREE.Group();
  private disposed = false;

  // リング・両回りの矢印・弧・スポーク・目盛りを組む。非表示のまま組み、
  // addToScene なら scene へ足す。
  public constructor(private readonly scene?: THREE.Scene, addToScene = true) {
    this.object.name = 'rotation-ring';
    this.object.visible = false;
    const ring = new THREE.Line(this.ringGeometry, this.ringMaterial);
    this.arrows = new THREE.LineSegments(this.arrowsGeometry, this.ringMaterial);
    this.arc = new THREE.Line(this.arcGeometry, this.dragMaterial);
    this.arc.visible = false;
    const spokeLine = new THREE.Line(this.spokeGeometry, this.dragMaterial);
    this.spoke.add(spokeLine);
    this.spoke.visible = false;
    this.ticks = new THREE.LineSegments(this.ticksGeometry, this.dragMaterial);
    this.ticks.visible = false;
    // 弧・目盛りの頂点は書き換える都度 drawRange で切るので、毎フレームの視錐台判定はしない。
    for (const part of [ring, this.arrows, this.arc, spokeLine, this.ticks]) {
      part.renderOrder = 1;
      part.frustumCulled = false;
    }
    this.object.add(ring, this.arrows, this.arc, this.spoke, this.ticks);
    markOverlay(this.object);
    if (addToScene) scene?.add(this.object);
  }

  // そのフレームの宣言へ同期する。null なら隠す。
  public sync(display: RotationRingDisplay | null): void {
    if (this.disposed) throw new Error('cannot sync a disposed RotationRingView');
    if (display === null) {
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.object.position.set(display.position.x, display.position.y, display.position.z);
    const q = qNormalize(display.rotation);
    this.object.quaternion.set(q.x, q.y, q.z, q.w);
    this.object.scale.setScalar(display.radius);

    // ドラッグ中は矢印を伏せ、回した角度の弧と、適用される 90° 単位の位置を出す。
    const drag = display.drag;
    this.arrows.visible = drag === null;
    this.arc.visible = drag !== null;
    this.spoke.visible = drag !== null;
    this.ticks.visible = drag !== null;
    if (drag !== null) this.syncDrag(drag);
  }

  // 資源を畳む。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene?.remove(this.object);
    // 確保した geometry と material を解放する。
    this.ringGeometry.dispose();
    this.arrowsGeometry.dispose();
    this.arcGeometry.dispose();
    this.spokeGeometry.dispose();
    this.ticksGeometry.dispose();
    this.ringMaterial.dispose();
    this.dragMaterial.dispose();
  }

  // 掴んだ点から現在の角までの弧と、離したときに適用される 90° 単位の位置を書く。
  // 段数ごとの目盛りは適用される向きへ並べ、終端の放射線が掴んだ点からの合成角を示す。
  private syncDrag(drag: RotationRingDrag): void {
    // 弧の頂点を、掴んだ点から現在の角まで並べ直す。
    const positions = this.arcGeometry.getAttribute('position') as THREE.BufferAttribute;
    const vertices = Math.max(
      2, Math.min(ARC_VERTICES, Math.ceil(Math.abs(drag.angle) / (2 * Math.PI) * RING_SEGMENTS) + 1),
    );
    for (let index = 0; index < vertices; index++) {
      const angle = drag.startAngle + drag.angle * (index / (vertices - 1));
      positions.setXYZ(index, Math.cos(angle), Math.sin(angle), 0);
    }
    positions.needsUpdate = true;
    this.arcGeometry.setDrawRange(0, vertices);

    // 段数ごとの目盛りを、いま離したときに適用される向きへ並べる。
    const ticks = this.ticksGeometry.getAttribute('position') as THREE.BufferAttribute;
    const count = Math.min(MAX_STEP_TICKS, Math.abs(drag.appliedSteps));
    const direction = Math.sign(drag.appliedSteps) || 1;
    for (let index = 0; index < count; index++) {
      const angle = drag.startAngle + direction * (index + 1) * (Math.PI / 2);
      ticks.setXYZ(index * 2, Math.cos(angle) * STEP_TICK_INNER, Math.sin(angle) * STEP_TICK_INNER, 0);
      ticks.setXYZ(index * 2 + 1, Math.cos(angle) * STEP_TICK_OUTER, Math.sin(angle) * STEP_TICK_OUTER, 0);
    }
    ticks.needsUpdate = true;
    this.ticksGeometry.setDrawRange(0, count * 2);
    this.spoke.rotation.z = drag.startAngle + drag.appliedSteps * (Math.PI / 2);
  }
}

// リング系の線の material。深度を切るので船体に隠れても見える。
function ringMaterial(opacity: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color: RING_COLOR, transparent: true, opacity, depthTest: false, depthWrite: false,
  });
}

// 単位円のラインループ。端点を閉じて持たせる。
function buildRingGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array((RING_SEGMENTS + 1) * 3);
  for (let index = 0; index <= RING_SEGMENTS; index++) {
    const angle = (index / RING_SEGMENTS) * Math.PI * 2;
    positions[index * 3] = Math.cos(angle);
    positions[index * 3 + 1] = Math.sin(angle);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

// 両回りの矢印。基準角 0 と π の円周上に、それぞれ正・負の回転方向を指す羽根を持つ。
// 局所 +Z まわりの正の回転は +X → +Y へ向かうので、基準角 0 の矢印は +Y、
// π の矢印(点は対極)は負の回転を指す。
function buildArrowsGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array(8 * 3);
  // tipAngle の円周上の点を先端とし、positions の offset から2線分ぶんを書き込む。
  const barb = (tipAngle: number, offset: number): void => {
    const tip = new THREE.Vector3(Math.cos(tipAngle), Math.sin(tipAngle), 0);
    // 羽根の傾きは常に +Y 固定。tip が対極に来ると接線に対する向きが反転する。
    const dir = new THREE.Vector3(0, 1, 0);
    const back = dir.multiplyScalar(-Math.cos(ARROW_BARB_ANGLE) * ARROW_BARB_LENGTH);
    const spread = tip.clone().multiplyScalar(Math.sin(ARROW_BARB_ANGLE) * ARROW_BARB_LENGTH);
    for (const [index, sign] of [[0, 1], [1, -1]] as const) {
      const end = tip.clone().add(back).addScaledVector(spread, sign);
      positions[(offset + index * 2) * 3] = tip.x;
      positions[(offset + index * 2) * 3 + 1] = tip.y;
      positions[(offset + index * 2 + 1) * 3] = end.x;
      positions[(offset + index * 2 + 1) * 3 + 1] = end.y;
    }
  };
  barb(0, 0);
  barb(Math.PI, 4);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

// ドラッグの弧の頂点バッファ。毎フレーム書き換えて drawRange で切る。
function buildArcGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_VERTICES * 3), 3));
  return geometry;
}

// スナップ位置の放射線(単位円空間で +X 方向)。spoke グループの Z 回転で向きを合わせる。
function buildSpokeGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array([SNAP_SPOKE_INNER, 0, 0, SNAP_SPOKE_OUTER, 0, 0]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

// 90° 段数の目盛りの頂点バッファ。毎フレーム書き換えて drawRange で切る。
function buildTicksGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position', new THREE.BufferAttribute(new Float32Array(MAX_STEP_TICKS * 2 * 3), 3),
  );
  return geometry;
}
