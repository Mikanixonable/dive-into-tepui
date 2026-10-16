// 論理番号で連続性を判定し、再利用しない通し番号で物体の前モデルを選んで G バッファへ動きベクトルを書く。
import * as THREE from 'three/webgpu';
import type NodeBuilder from 'three/src/nodes/core/NodeBuilder.js';
import {
  Fn, float, instanceIndex, modelWorldMatrix, positionGeometry, positionLocal, renderGroup, select, storage, uniform, uint,
  varying, vec2, vec4,
} from 'three/tsl';
import type { Vec3Node, Vec4Node } from '../tsl-types';

// rgba16f の rg で正確に表せ、画面外の前座標として読む側が棄却できる値。
export const MOTION_NO_HISTORY = 1e4;
// uint の全 1 は、更新対象の動きそのものを棄却する物体印に予約する。
const MOTION_REJECTED_FRAME = 0xffff_ffff;
// 論理番号と通し番号の上限。予約済みの全 1 はどちらにも使わない。
const MAX_MOTION_FRAME = 0xffff_fffe;

interface ModelRecord {
  // 最後に物体更新が走った番号。行列が変わらない間は更新されず、シェーダが現 modelWorldMatrix を前にも使う。
  frame: number;
  // 論理番号が振り直されても再利用しない、シェーダ比較用の通し番号。
  renderSerial: number;
  // 最後に onObjectUpdate が読んだ modelWorldMatrix。
  current: THREE.Matrix4;
  // 最後の物体更新より前に読んだ modelWorldMatrix。初回は零行列。
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

// 描画物からパイプラインを参照せず、親物体を履歴鍵にできるように印をモジュールで持つ。
const historyKeys = new WeakMap<THREE.Object3D, THREE.Object3D>();
// プールやタンパク質など、全画素の前位置を定義しない物体の印。
const rejectedObjects = new WeakSet<THREE.Object3D>();
// 描画中のカメラから MotionHistory を引く対応表。描画物へ履歴実体を渡さず、材質の onObjectUpdate から履歴を引く。
const historiesByCamera = new WeakMap<THREE.Camera, MotionHistory>();
// 履歴がない前変換。零行列なので clip の w が 0 となる。
const zeroMatrix = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

const poolMotionByMesh = new WeakMap<THREE.InstancedMesh, PoolMotionHistory>();
const registeredMotionPools = new Set<PoolMotionHistory>();

// MotionHistory.setFrame が G バッファ描画前に値を書き、renderGroup の binding が描画ごとに GPU へ送る。
const currentViewProjection = uniform(new THREE.Matrix4()).setGroup(renderGroup);
const previousViewProjection = uniform(new THREE.Matrix4()).setGroup(renderGroup);
const renderSerial = uniform(0, 'uint').setGroup(renderGroup);

// 描画物の履歴鍵を指定する。指定しない物は描画物自身が鍵になる。
export function markMotionHistoryKey(object: THREE.Object3D, key: THREE.Object3D): void {
  historyKeys.set(object, key);
}

// 対象の描画物が書く動きベクトルを棄却の印にする。
export function markMotionRejected(object: THREE.Object3D): void {
  rejectedObjects.add(object);
}

// 参照撮影が棄却対象の実体を深度画像から識別できるよう、印の有無を問い合わせる。
export function isMotionRejected(object: THREE.Object3D): boolean {
  return rejectedObjects.has(object);
}

// 描画物のマテリアルが交点を動きベクトルへ使う。
export function motionNodeAtPosition(position: Vec3Node): Vec4Node {
  return createMotionNode(position);
}

export class MotionHistory {
  // カメラ実体ごとに物体履歴を分け、別カメラへ前 model を流用しない。
  private readonly models = new WeakMap<THREE.Camera, WeakMap<THREE.Object3D, ModelRecord>>();
  // 透視・平行やカメラの交換ごとに P×V の前歴を分ける。
  private readonly cameras = new WeakMap<THREE.Camera, CameraRecord>();
  // 射影と view を積む一時行列。カメラの射影行列は直接変更しない。
  private readonly viewProjection = new THREE.Matrix4();
  // 現在の描画に渡す番号。renderGroup の番号 uniform は render 時に読む。
  private frame = 0;
  // 新しい論理フレームごとに 1 進む。物体 uniform の番号と照合する。
  private renderSerial = -1;
  // setFrame が初回かどうかを区別する。
  private hasFrame = false;
  // G バッファの動き節。
  public readonly node: Vec4Node = createMotionNode(positionLocal);

  // G バッファを描く前に毎回呼ぶ。論理番号とカメラの前歴を更新し、同じ番号の描き直しでは通し番号を進めない。
  public setFrame(frame: number, camera: THREE.Camera): void {
    // 同じ論理番号の再描画では、物体との照合に使う通し番号を保つ。
    if (!Number.isInteger(frame) || frame < 0 || frame > MAX_MOTION_FRAME) {
      throw new RangeError(`Invalid motion frame ${frame}`);
    }
    const isNewFrame = !this.hasFrame || frame !== this.frame;
    const nextRenderSerial = this.renderSerial + Number(isNewFrame);
    if (nextRenderSerial > MAX_MOTION_FRAME) {
      throw new RangeError(`Invalid motion render serial ${nextRenderSerial}`);
    }
    this.renderSerial = nextRenderSerial;
    this.hasFrame = true;
    this.frame = frame;
    // 射影と view を作業行列へ積み、カメラ記録には独立した行列を保持する。
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
    currentViewProjection.value.copy(this.viewProjection);
    previousViewProjection.value.copy(record?.previous ?? zeroMatrix);
    renderSerial.value = this.renderSerial;
    this.writePoolMatrices(camera);
    historiesByCamera.set(camera, this);
  }

  // 現在の各枠の実体から、連続した前フレームの model 行列を枠順に書く。
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

  // テストと G バッファ描画前の書き込みからカメラ記録を読む。
  public cameraRecord(camera: THREE.Camera): Readonly<CameraRecord> | null {
    return this.cameras.get(camera) ?? null;
  }

  // onObjectUpdate が呼ばれた物体だけ記録を進める。番号が飛んでも、未更新だった current を前として扱う。
  private updateModel(object: THREE.Object3D, camera: THREE.Camera, rejectGaps = false): ModelRecord | null {
    if (!this.cameras.get(camera)) return null;
    let key = historyKeys.get(object);
    if (!key) key = object;
    let byObject = this.models.get(camera);
    if (!byObject) {
      byObject = new WeakMap();
      this.models.set(camera, byObject);
    }
    let record = byObject.get(key);
    if (!record) {
      record = {
        frame: this.frame, renderSerial: this.renderSerial,
        current: object.matrixWorld.clone(), previous: zeroMatrix.clone(),
      };
      byObject.set(key, record);
    } else if (record.frame !== this.frame) {
      // render-lab は列を切り替えると番号を戻す。変わらない物体はその間 onObjectUpdate が走らないため、
      // 記録済み current を新しい列の前 model として使う。カメラの前行列は列の先頭で零になる。
      if (!rejectGaps || record.frame + 1 === this.frame) record.previous.copy(record.current);
      else record.previous.copy(zeroMatrix);
      record.current.copy(object.matrixWorld);
      record.frame = this.frame;
      record.renderSerial = this.renderSerial;
    } else {
      record.current.copy(object.matrixWorld);
    }
    return record;
  }

  // テスト用読み口。呼び出すと描画物の onObjectUpdate と同じ記録更新を行う。
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
    for (let slot = 0; slot < this.slotObjects.length; slot++) {
      target.set(previousOf(this.slotObjects[slot]!).elements, slot * 16);
    }
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

// objectFrame と現在の通し番号から、記録した前モデルを選ぶか返す。棄却印は予約値として扱う。
export function useRecordedPreviousModel(objectFrame: number, renderSerial: number): boolean {
  return objectFrame === renderSerial || objectFrame === MOTION_REJECTED_FRAME;
}

// 前 clip の w≤0 は rg の両成分に 1e4。通常値は今の uv−前の uv、b は前深度−今深度、a は 0。
class MotionNode extends THREE.Node {
  // position は描画物のローカル位置を受け取り、vec4 の動き添付を返す。
  public constructor(private readonly position: Vec3Node) {
    super('vec4');
  }

  // NodeBuilder の構築時に呼ばれ、描画物とカメラに対応するノードを返す。
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

// position は Vec3Node とし、返り値を vec4 の動き添付として使う。
function createMotionNode(position: Vec3Node): Vec4Node {
  // 通常面と位置指定面で共有する vec4 動きノードを作る。
  return new MotionNode(position) as unknown as Vec4Node;
}

// setViewOffset を含む射影を、カメラ本来の投影へ戻す。戻り値はカメラの行列そのものでありうるので書き換えない。
function unjitteredProjection(camera: THREE.Camera): THREE.Matrix4 {
  // view offset が無い場合は、カメラが描画に使う射影をそのまま返す。
  if (!(camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera)
    || camera.view === null || !camera.view.enabled) return camera.projectionMatrix;
  // view offset を除いた射影を複製上で作り、必要なら深度の向きを元カメラに合わせる。
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
