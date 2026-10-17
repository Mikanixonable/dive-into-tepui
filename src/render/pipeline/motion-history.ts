// G バッファへ書く動きベクトル(前フレームからの画面上の移動と深度の変化)の節と、それが読む前フレームの変換 —
// カメラごとの射影 × view、物体ごとの model、InstancedMesh の枠ごとの model — の記録。
import * as THREE from 'three/webgpu';
import type NodeBuilder from 'three/src/nodes/core/NodeBuilder.js';
import {
  Fn, float, instanceIndex, modelWorldMatrix, positionGeometry, positionLocal, renderGroup, select, storage, uniform,
  uint, varying, vec2, vec4,
} from 'three/tsl';
import type { Vec3Node, Vec4Node } from '../tsl-types';

// 前フレームの位置が無い画素で、動きベクトルの rg の両成分に書く値。rgba16f で正確に表せ、uv の差としては画面の外を指す。
export const MOTION_NO_HISTORY = 1e4;
// 棄却の印を付けた物体の番号(uint の全 1)。シェーダは常に記録した前 model(零行列)を選び、履歴なしを書く。
const MOTION_REJECTED_FRAME = 0xffff_ffff;
// 論理番号と通し番号の上限。予約済みの全 1 はどちらにも使わない。
const MAX_MOTION_FRAME = 0xffff_fffe;

interface ModelRecord {
  // 最後に記録を進めた論理番号。物体更新は行列が変わらない間は走らないので、古いまま残りうる。
  frame: number;
  // 論理番号が振り直されても再利用しない、シェーダ比較用の通し番号。
  renderSerial: number;
  // 最後に記録した物体の matrixWorld。
  current: THREE.Matrix4;
  // 最後に記録を進める前の current。初回は零行列。
  previous: THREE.Matrix4;
}

interface CameraRecord {
  // 現在の論理番号。
  frame: number;
  // ジッターを外した現在の射影 × view。
  current: THREE.Matrix4;
  // 連続した前番号の射影 × view。欠番・初回は零行列。
  previous: THREE.Matrix4;
}

// 描画物 → 履歴の鍵。分割段のように複数の描画物が 1 つの物体を描くとき、物体で履歴を束ねる。
const historyKeys = new WeakMap<THREE.Object3D, THREE.Object3D>();
// 動きベクトルを常に履歴なしにする描画物(頂点を model 行列の外で動かすものなど)。
const rejectedObjects = new WeakSet<THREE.Object3D>();
// カメラ → それを最後に setFrame した履歴。材質の物体更新が、描画中のカメラから履歴を引く。
const historiesByCamera = new WeakMap<THREE.Camera, MotionHistory>();
// 履歴がない前変換。零行列なので clip の w が 0 となる。
const zeroMatrix = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

// InstancedMesh → その枠の履歴。動き節がメッシュから引く。
const poolMotionByMesh = new WeakMap<THREE.InstancedMesh, PoolMotionHistory>();
// 破棄されていないプールの履歴。setFrame のたびに前フレームの model を書き込む。
const registeredMotionPools = new Set<PoolMotionHistory>();

// 描画中のカメラの今と前の射影 × view と、通し番号。setFrame が G バッファを描く前に書く。
const currentViewProjection = uniform(new THREE.Matrix4()).setGroup(renderGroup);
const previousViewProjection = uniform(new THREE.Matrix4()).setGroup(renderGroup);
const renderSerial = uniform(0, 'uint').setGroup(renderGroup);

// 描画物の履歴鍵を指定する。指定しない物は描画物自身が鍵になる。
export function markMotionHistoryKey(object: THREE.Object3D, key: THREE.Object3D): void {
  historyKeys.set(object, key);
}

// 描画物 object の動きベクトルを常に履歴なし(MOTION_NO_HISTORY)にする。
export function markMotionRejected(object: THREE.Object3D): void {
  rejectedObjects.add(object);
}

// 物体空間の位置 position(レイマーチの交点など)から動きベクトルの節を作る。材質の mrtNode の motion へ渡す。
export function motionNodeAtPosition(position: Vec3Node): Vec4Node {
  // MotionNode は vec4 の節なので Vec4Node として扱える。
  return new MotionNode(position) as unknown as Vec4Node;
}

// カメラごとの射影 × view と、物体ごとの model の前フレームの記録。G バッファを描く前に setFrame で論理フレームの
// 番号とカメラを渡すと、動き節が読む前の変換を揃える。
export class MotionHistory {
  // カメラごとの、履歴の鍵 → 物体の記録。
  private readonly models = new WeakMap<THREE.Camera, WeakMap<THREE.Object3D, ModelRecord>>();
  // カメラごとの射影 × view の記録。
  private readonly cameras = new WeakMap<THREE.Camera, CameraRecord>();
  // 射影 × view の作業領域。
  private readonly viewProjection = new THREE.Matrix4();
  // 直近の setFrame の論理番号。一度も setFrame していなければ null。
  private frame: number | null = null;
  // 論理番号が替わるたびに 1 進む通し番号。物体の記録の番号と照合する。
  private renderSerial = -1;
  // G バッファの動き節。
  public readonly node: Vec4Node = motionNodeAtPosition(positionLocal);

  // G バッファを描く前に毎回呼び、論理番号 frame とカメラ camera の記録を進める。同じ番号の描き直しは通し番号を保つ。
  // frame は 0..MAX_MOTION_FRAME の整数で、外れると投げる。
  public setFrame(frame: number, camera: THREE.Camera): void {
    // 論理番号を検査し、番号が替わったら通し番号を進める。
    if (!Number.isInteger(frame) || frame < 0 || frame > MAX_MOTION_FRAME) {
      throw new RangeError(`Invalid motion frame ${frame}`);
    }
    const isNewFrame = frame !== this.frame;
    const nextRenderSerial = this.renderSerial + Number(isNewFrame);
    if (nextRenderSerial > MAX_MOTION_FRAME) {
      throw new RangeError(`Invalid motion render serial ${nextRenderSerial}`);
    }
    this.renderSerial = nextRenderSerial;
    this.frame = frame;
    // カメラの記録を進める。連続した番号なら前の射影 × view を引き継ぎ、記録には作業領域の複製を持つ。
    this.viewProjection.multiplyMatrices(unjitteredProjection(camera), camera.matrixWorldInverse);
    const record = this.cameras.get(camera) ?? null;
    if (record === null) {
      this.cameras.set(camera, { frame, current: this.viewProjection.clone(), previous: zeroMatrix.clone() });
    } else if (record.frame === frame) {
      record.current.copy(this.viewProjection);
    } else {
      if (record.frame + 1 === frame) record.previous.copy(record.current);
      else record.previous.copy(zeroMatrix);
      record.current.copy(this.viewProjection);
      record.frame = frame;
    }
    // 描画が読む uniform とプールの前 model を書く。
    currentViewProjection.value.copy(this.viewProjection);
    previousViewProjection.value.copy(record?.previous ?? zeroMatrix);
    renderSerial.value = this.renderSerial;
    this.writePoolMatrices(camera);
    historiesByCamera.set(camera, this);
  }

  // 各プールの枠へ、置かれた個体の前フレームの model 行列を camera の記録から書く。番号が連続していない個体は零行列。
  // 同じ論理番号の間は何度呼んでも同じ値を書く。
  public writePoolMatrices(camera: THREE.Camera): void {
    for (const pool of registeredMotionPools) {
      pool.writePrevious((object) => this.updateModel(object, camera, true)?.previous ?? zeroMatrix);
    }
  }

  // 物体更新時に前 model を返す。明示棄却・初回は零行列を返す。
  public previousModelFor(object: THREE.Object3D, camera: THREE.Camera): THREE.Matrix4 {
    const record = this.updateModel(object, camera);
    if (record === null || rejectedObjects.has(object)) {
      return zeroMatrix;
    }
    return record.previous;
  }

  // 物体更新時に記録した通し番号を返す。棄却印は全フレームで零 model を選ぶ予約番号にする。
  public modelFrameFor(object: THREE.Object3D, camera: THREE.Camera): number {
    if (rejectedObjects.has(object)) {
      this.updateModel(object, camera);
      return MOTION_REJECTED_FRAME;
    }
    return this.updateModel(object, camera)?.renderSerial ?? this.renderSerial;
  }

  // camera の射影 × view の記録。一度も setFrame していないカメラでは null。
  public cameraRecord(camera: THREE.Camera): Readonly<CameraRecord> | null {
    return this.cameras.get(camera) ?? null;
  }

  // object の記録を現在の論理番号まで進めて返す。番号が替わっていれば最後に記録した current を前とし、rejectGaps なら
  // 連続していない番号で零行列を前とする。camera を一度も setFrame していなければ null。
  private updateModel(object: THREE.Object3D, camera: THREE.Camera, rejectGaps = false): ModelRecord | null {
    const frame = this.frame;
    if (frame === null || !this.cameras.get(camera)) return null;
    const key = historyKeys.get(object) ?? object;
    let byObject = this.models.get(camera);
    if (!byObject) {
      byObject = new WeakMap();
      this.models.set(camera, byObject);
    }
    let record = byObject.get(key);
    if (!record) {
      record = {
        frame, renderSerial: this.renderSerial,
        current: object.matrixWorld.clone(), previous: zeroMatrix.clone(),
      };
      byObject.set(key, record);
    } else if (record.frame !== frame) {
      // 物体更新は行列が変わらない間は走らないので、番号の飛びや戻りは物体の不連続を意味せず、記録済みの current が
      // そのまま前になる。プールの個体は毎フレーム記録するので、番号の飛びは置かれなかった間を意味する(rejectGaps)。
      if (!rejectGaps || record.frame + 1 === frame) record.previous.copy(record.current);
      else record.previous.copy(zeroMatrix);
      record.current.copy(object.matrixWorld);
      record.frame = frame;
      record.renderSerial = this.renderSerial;
    } else {
      record.current.copy(object.matrixWorld);
    }
    return record;
  }

  // object の記録を、物体更新と同じく現在の論理番号まで進めて読む。setFrame 前のカメラでは null。
  public read(object: THREE.Object3D, camera: THREE.Camera): Readonly<ModelRecord> | null {
    return this.updateModel(object, camera);
  }
}

// 積み直す InstancedMesh の動きベクトルの履歴。枠に置いた個体を履歴の鍵にし、前フレームの model 行列を
// 枠順の器へ書く。毎フレーム beginFrame → place(...) の順に、InstancedMesh の枠と同じ順で個体を置く。
export class PoolMotionHistory {
  // 枠順の前フレームの model 行列。
  public readonly previousMatrices: THREE.StorageInstancedBufferAttribute;
  // 今フレームに枠の順に置いた個体。
  private readonly slotObjects: THREE.Object3D[] = [];
  // slotObjects と同じ個体。2度置かれたかを引くために持つ。
  private readonly placedObjects = new Set<THREE.Object3D>();

  // mesh の capacity 個の枠の履歴を作り、G バッファの動き節が mesh から引けるよう登録する。
  public constructor(private readonly mesh: THREE.InstancedMesh, capacity: number) {
    this.previousMatrices = new THREE.StorageInstancedBufferAttribute(capacity, 16);
    poolMotionByMesh.set(mesh, this);
    registeredMotionPools.add(this);
  }

  // 置き直しを始める。前フレームに置いた個体を枠から外す。
  public beginFrame(): void {
    this.slotObjects.length = 0;
    this.placedObjects.clear();
  }

  // 次の枠に個体を置く。object は個体そのもので、フレームをまたいで同じ個体には同じ Object3D を渡す。
  // 1つの Object3D を書き換えて複数の個体に使い回すと履歴を取り違えるので、同じフレームに2度置くと例外を投げる。
  public place(object: THREE.Object3D): void {
    if (this.placedObjects.has(object)) {
      throw new Error('PoolMotionHistory: 同じ Object3D を同じフレームの2つの枠へ置けない — 個体ごとに別の Object3D を渡す');
    }
    this.placedObjects.add(object);
    this.slotObjects.push(object);
  }

  // 置いた個体ごとに previousOf が返す前フレームの model 行列を、枠順の器へ書いて転送させる。
  public writePrevious(previousOf: (object: THREE.Object3D) => THREE.Matrix4): void {
    const target = this.previousMatrices.array as Float32Array;
    for (const [slot, object] of this.slotObjects.entries()) target.set(previousOf(object).elements, slot * 16);
    this.previousMatrices.clearUpdateRanges();
    if (this.slotObjects.length > 0) this.previousMatrices.addUpdateRange(0, this.slotObjects.length * 16);
    this.previousMatrices.needsUpdate = true;
  }

  // 登録を外し、器を解放する。
  public dispose(): void {
    poolMotionByMesh.delete(this.mesh);
    registeredMotionPools.delete(this);
    this.previousMatrices.dispose();
  }
}

// 物体の記録の番号 objectFrame と現在の通し番号 renderSerial から、記録した前 model を選ぶか。棄却の印の番号では常に選ぶ。
export function useRecordedPreviousModel(objectFrame: number, renderSerial: number): boolean {
  return objectFrame === renderSerial || objectFrame === MOTION_REJECTED_FRAME;
}

// 動きベクトルの節。rg は今の uv − 前の uv(前の clip の w ≤ 0 なら両成分 MOTION_NO_HISTORY)、b は前の深度 − 今の深度、
// a は 0。
class MotionNode extends THREE.Node {
  // position は物体空間の位置。
  public constructor(private readonly position: Vec3Node) {
    super('vec4');
  }

  // 描画物ごとに、前フレームの変換を読んで動きベクトルを求める節を組む。
  public override setup(builder: NodeBuilder): THREE.Node {
    // objectGroup は物ごとの matrixWorld 変更時だけ更新され、番号が古ければシェーダで現行 modelWorldMatrix を前にも使う。
    const previousModel = uniform(new THREE.Matrix4()).onObjectUpdate(({ object, camera }, self) => {
      const value = object === null || camera === null
        ? zeroMatrix : historiesByCamera.get(camera)?.previousModelFor(object, camera) ?? zeroMatrix;
      return self.value.copy(value);
    });
    const objectFrame = uniform(0, 'uint').onObjectUpdate(({ object, camera }) => (
      object === null || camera === null ? 0 : historiesByCamera.get(camera)?.modelFrameFor(object, camera) ?? 0
    ));
    // プールのメッシュでは、枠ごとの今と前の model を読む。
    const instancedMesh = builder.object as THREE.InstancedMesh;
    const pool = poolMotionByMesh.get(instancedMesh);
    const poolIndex = pool === undefined ? null : varying(instanceIndex).setInterpolation('flat');
    const poolPosition = pool === undefined ? null : varying(positionGeometry);
    const currentInstance = pool === undefined
      ? null
      : storage(instancedMesh.instanceMatrix, 'mat4', instancedMesh.instanceMatrix.count).element(poolIndex!);
    const previousInstance = pool === undefined
      ? null
      : storage(pool.previousMatrices, 'mat4', pool.previousMatrices.count).element(poolIndex!);
    return Fn(() => {
      // 今と前の描画座標を求める。
      const localPosition = pool === undefined ? vec4(this.position, 1) : vec4(poolPosition!, 1);
      const currentModelPosition = pool === undefined
        ? modelWorldMatrix.mul(localPosition)
        : modelWorldMatrix.mul(currentInstance!.mul(localPosition));
      const storedPreviousPosition = pool === undefined
        ? previousModel.mul(localPosition)
        : modelWorldMatrix.mul(previousInstance!.mul(localPosition));
      const useStored = objectFrame.equal(renderSerial).or(objectFrame.equal(uint(MOTION_REJECTED_FRAME)));
      const previousModelPosition = pool === undefined
        ? select(useStored, storedPreviousPosition, currentModelPosition)
        : storedPreviousPosition;
      // clip 座標の差を uv と深度の差へ写す。前の w ≤ 0 は履歴なし。
      const currentClipPosition = currentViewProjection.mul(currentModelPosition);
      const previousClipPosition = previousViewProjection.mul(previousModelPosition);
      const valid = previousClipPosition.w.greaterThan(0);
      const currentW = select(currentClipPosition.w.greaterThan(0), currentClipPosition.w, float(1));
      const previousW = select(valid, previousClipPosition.w, float(1));
      const movement = currentClipPosition.xy.div(currentW)
        .sub(previousClipPosition.xy.div(previousW)).mul(vec2(0.5, -0.5));
      const depthChange = select(
        valid, previousClipPosition.z.div(previousW).sub(currentClipPosition.z.div(currentW)), float(0),
      );
      return vec4(select(valid, movement, vec2(float(MOTION_NO_HISTORY))), depthChange, 0);
    })();
  }
}

// setViewOffset を含む射影を、カメラ本来の投影へ戻す。戻り値はカメラの行列そのものでありうるので書き換えない。
function unjitteredProjection(camera: THREE.Camera): THREE.Matrix4 {
  if (!(camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera)
    || camera.view === null || !camera.view.enabled) return camera.projectionMatrix;
  // 複製は反転深度を引き継がないので、反転深度のカメラでは複製の射影の深度の行を反転し直す。
  const projection = camera.clone();
  projection.clearViewOffset();
  projection.updateProjectionMatrix();
  if (!camera.reversedDepth) return projection.projectionMatrix;
  return new THREE.Matrix4().set(
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, -1, 1,
    0, 0, 0, 1,
  ).multiply(projection.projectionMatrix);
}
