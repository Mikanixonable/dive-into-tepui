// 論理フレームごとのカメラと物体の前変換を記録し、G バッファへ動きベクトルを書く。
import * as THREE from 'three/webgpu';
import {
  Fn, float, modelWorldMatrix, positionLocal, renderGroup, select, uniform, uint, varying, vec2, vec4,
} from 'three/tsl';
import type { Vec2Node, Vec3Node } from '../tsl-types';

// rg16f で正確に表せ、画面外の前座標として読む側が棄却できる値。
export const MOTION_NO_HISTORY = 1e4;
// uint の全 1 は、更新対象の動きそのものを棄却する物体印に予約する。
const MOTION_REJECTED_FRAME = 0xffff_ffff;
// uint uniform で正確に比較できる論理番号の上限。全 1 は物体印に使う。
const MAX_MOTION_FRAME = 0xffff_fffe;

interface ModelRecord {
  // 最後に物体更新が走った番号。行列が変わらない間は更新されず、シェーダが現 modelWorldMatrix を前にも使う。
  frame: number;
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

// MotionHistory.setFrame が G バッファ描画前に値を書き、renderGroup の binding が描画ごとに GPU へ送る。
const currentViewProjection = uniform(new THREE.Matrix4()).setGroup(renderGroup);
const previousViewProjection = uniform(new THREE.Matrix4()).setGroup(renderGroup);
const renderFrame = uniform(0, 'uint').setGroup(renderGroup);

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
export function motionNodeAtPosition(position: Vec3Node): Vec2Node {
  return createMotionNode(position, 'fragment');
}

export class MotionHistory {
  // カメラ実体ごとに物体履歴を分け、別カメラへ前 model を流用しない。
  private readonly models = new WeakMap<THREE.Camera, WeakMap<THREE.Object3D, ModelRecord>>();
  // 透視・平行やカメラの交換ごとに P×V の前歴を分ける。
  private readonly cameras = new WeakMap<THREE.Camera, CameraRecord>();
  // 現在の描画に渡す番号。renderGroup の番号 uniform は render 時に読む。
  private frame = 0;
  // G バッファの動き節。
  public readonly node: Vec2Node = createMotionNode(positionLocal, 'vertex');

  // 論理番号とカメラを選び、描画ごとの P×V 前後値を更新する。
  public setFrame(frame: number, camera: THREE.Camera): void {
    if (!Number.isInteger(frame) || frame < 0 || frame > MAX_MOTION_FRAME) {
      throw new RangeError(`Invalid motion frame ${frame}`);
    }
    this.frame = frame;
    const viewProjection = unjitteredProjection(camera).multiply(camera.matrixWorldInverse);
    const record = this.cameras.get(camera) ?? null;
    if (record === null) {
      this.cameras.set(camera, { frame, current: viewProjection, previous: zeroMatrix.clone() });
    } else if (record.frame === frame) {
      record.current.copy(viewProjection);
    } else {
      if (record.frame + 1 === frame) record.previous.copy(record.current);
      else record.previous.copy(zeroMatrix);
      record.current.copy(viewProjection);
      record.frame = frame;
    }
    currentViewProjection.value.copy(viewProjection);
    previousViewProjection.value.copy(record?.previous ?? zeroMatrix);
    renderFrame.value = frame;
    historiesByCamera.set(camera, this);
  }

  // 物体更新時に前 model を返す。明示棄却・初回は零行列を返す。
  public previousModelFor(object: THREE.Object3D, camera: THREE.Camera): THREE.Matrix4 {
    const record = this.updateModel(object, camera);
    if (record === null || rejectedObjects.has(object)) {
      return zeroMatrix;
    }
    return record.previous;
  }

  // 物体更新時にその値を書いた番号を返す。棄却印は全フレームで零 model を選ぶ予約番号にする。
  public modelFrameFor(object: THREE.Object3D, camera: THREE.Camera): number {
    if (rejectedObjects.has(object)) {
      this.updateModel(object, camera);
      return MOTION_REJECTED_FRAME;
    }
    return this.updateModel(object, camera)?.frame ?? this.frame;
  }

  // テストと G バッファ描画前の書き込みからカメラ記録を読む。
  public cameraRecord(camera: THREE.Camera): Readonly<CameraRecord> | null {
    return this.cameras.get(camera) ?? null;
  }

  // onObjectUpdate が呼ばれた物体だけ記録を進める。番号が飛んでも、未更新だった current を前として扱う。
  private updateModel(object: THREE.Object3D, camera: THREE.Camera): ModelRecord | null {
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
      record = { frame: this.frame, current: object.matrixWorld.clone(), previous: zeroMatrix.clone() };
      byObject.set(key, record);
    } else if (record.frame !== this.frame) {
      // render-lab は列を切り替えると番号を戻す。変わらない物体はその間 onObjectUpdate が走らないため、
      // 記録済み current を新しい列の前 model として使う。カメラの前行列は列の先頭で零になる。
      record.previous.copy(record.current);
      record.current.copy(object.matrixWorld);
      record.frame = this.frame;
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

// 棄却印は予約番号、更新済み model は現在番号、古い番号は今の modelWorldMatrix を前位置に選ぶ。
export function useRecordedPreviousModel(objectFrame: number, frame: number): boolean {
  return objectFrame === frame || objectFrame === MOTION_REJECTED_FRAME;
}

// 前と今の clip を求める段。頂点の位置なら頂点で求めて補間する — clip は位置の一次式なので、透視補正の補間で
// 画素で求めたのと丸めの差しか生まれず、画素ごとの行列とベクトルの積を省ける。画素で決まる位置(雲殻の交点)は画素で求める。
type ClipStage = 'vertex' | 'fragment';

// 前 clip の w≤0 は両成分に 1e4。通常値は今の uv−前の uv、uv の y は下向き。
class MotionNode extends THREE.Node {
  public constructor(private readonly position: Vec3Node, private readonly stage: ClipStage) {
    super('vec2');
  }

  public override setup(): THREE.Node {
    // objectGroup は物ごとの matrixWorld 変更時だけ更新され、番号が古ければシェーダで現行 modelWorldMatrix を前にも使う。
    const previousModel = uniform(new THREE.Matrix4()).onObjectUpdate(({ object, camera }, self) => {
      const value = object === null || camera === null
        ? zeroMatrix : historiesByCamera.get(camera)?.previousModelFor(object, camera) ?? zeroMatrix;
      return self.value.copy(value);
    });
    const objectFrame = uniform(0, 'uint').onObjectUpdate(({ object, camera }) => (
      object === null || camera === null ? 0 : historiesByCamera.get(camera)?.modelFrameFor(object, camera) ?? 0
    ));
    return Fn(() => {
      const localPosition = vec4(this.position, 1);
      const currentModelPosition = modelWorldMatrix.mul(localPosition);
      const storedPreviousPosition = previousModel.mul(localPosition);
      const useStored = objectFrame.equal(renderFrame).or(objectFrame.equal(uint(MOTION_REJECTED_FRAME)));
      const previousModelPosition = select(useStored, storedPreviousPosition, currentModelPosition);
      const currentClipPosition = currentViewProjection.mul(currentModelPosition);
      const previousClipPosition = previousViewProjection.mul(previousModelPosition);
      const currentClip = this.stage === 'vertex' ? varying(currentClipPosition) : currentClipPosition;
      const previousClip = this.stage === 'vertex' ? varying(previousClipPosition) : previousClipPosition;
      const valid = previousClip.w.greaterThan(0);
      const currentW = select(currentClip.w.greaterThan(0), currentClip.w, float(1));
      const previousW = select(valid, previousClip.w, float(1));
      const movement = currentClip.xy.div(currentW)
        .sub(previousClip.xy.div(previousW)).mul(vec2(0.5, -0.5));
      return select(valid, movement, vec2(float(MOTION_NO_HISTORY)));
    })();
  }
}

function createMotionNode(position: Vec3Node, stage: ClipStage): Vec2Node {
  return new MotionNode(position, stage) as unknown as Vec2Node;
}

// setViewOffset を含む射影を、カメラ本来の投影へ戻す。
function unjitteredProjection(camera: THREE.Camera): THREE.Matrix4 {
  if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
    const copy = camera.clone();
    copy.clearViewOffset();
    copy.updateProjectionMatrix();
    return copy.projectionMatrix;
  }
  return camera.projectionMatrix;
}
