// ケースを論理フレームごとに描き、G バッファの動きベクトルを、深度・カメラ・実体から求めた動きの参照と照合する。
import * as THREE from 'three/webgpu';
import {
  reprojectedPixels, reprojectionMatrixBetween,
} from './reference-reprojection';
import { motionReferenceOf, type MotionReferenceFrame, type MotionReferenceResult } from './motion-reference';
import type { LabView } from './lab';
import type { LabCase, LabMotionEntity } from './lab-case';

// 1 フレームの記録。capture は全体の絵の PNG のデータ URL、frame はケースへ置いた論理フレーム。
export interface MotionVectorFrameRecord extends MotionReferenceResult {
  readonly capture: string;
  readonly frame: number;
}

// 論理フレームを 1 つずつ置いて描き、前に置いたフレームとの動きの参照を求める。
export class MotionVectorCheck {
  private previous: MotionReferenceFrame | null = null;

  public constructor(private readonly view: LabView) {}

  // frame をケースへ置いて描き、前のフレームからの動きの参照を求める。compareDepth なら、世界が静止しているとみなして
  // 深度の参照の写像との自己検算と、GPU の深度による参照の再投影との差も求める。forceNoHistory なら前のフレームが無い
  // ものとして照合し、verifyRepeated なら同じフレームを描き直して動きベクトルが変わらないかも数える。
  public async frame(
    frame: number, compareDepth: boolean, forceNoHistory = false, verifyRepeated = true,
  ): Promise<MotionVectorFrameRecord> {
    // 描いて動きベクトルを読み、描き直しで値が変わった成分を数える。
    this.view.setFrame(frame);
    const capture = await this.view.captureSettled(`motion reference ${frame}`);
    const motion = await this.view.readFloat('motion');
    let sameFrameMismatchCount = 0;
    if (verifyRepeated) {
      await this.view.capture();
      const repeatedMotion = await this.view.readFloat('motion');
      sameFrameMismatchCount = motion.rgba.reduce(
        (count, value, index) => count + (value === repeatedMotion.rgba[index] ? 0 : 1), 0,
      );
    }
    // 参照を求める 1 フレーム。タンパク質のケースは実体を渡さず、深度の参照にする。
    const currentCase = this.view.currentCase;
    const depth = await this.view.readFloat('depth');
    const current: MotionReferenceFrame = {
      depth,
      motion,
      camera: this.view.camera.clone(),
      origin: currentCase?.renderOrigin?.() ?? new THREE.Vector3(),
      entities: currentCase?.proteinMotion === undefined ? entitiesAt(currentCase, frame) : [],
      rejectedObjects: currentCase?.proteinMotion === undefined ? rejectedObjectsAt(currentCase) : [],
    };
    // 前のフレームが無いはずなら、面のある全画素が履歴なしの印(成分の絶対値 1000 以上)を持つかを数える。
    const expectNoHistory = this.previous === null || forceNoHistory;
    let fullNoHistorySurfacePixelCount = 0;
    let fullNoHistoryMismatchCount = 0;
    if (expectNoHistory) {
      for (let pixel = 0; pixel < depth.width * depth.height; pixel++) {
        if (depth.rgba[4 * pixel]! <= 0) continue;
        fullNoHistorySurfacePixelCount++;
        const x = motion.rgba[4 * pixel]!;
        const y = motion.rgba[4 * pixel + 1]!;
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.max(Math.abs(x), Math.abs(y)) < 1000) {
          fullNoHistoryMismatchCount++;
        }
      }
    }
    // 世界が静止しているとみなしたときの今から前への写像と、GPU の深度による再投影。
    const previousCamera = this.previous === null ? null : worldCameraOf(this.previous);
    const currentCamera = worldCameraOf(current);
    const toPrevious = compareDepth && previousCamera !== null
      ? reprojectionMatrixBetween(currentCamera, previousCamera)
      : null;
    const gpuReprojected = toPrevious === null || this.previous === null ? null
      : reprojectedPixels(
        current.depth, currentCamera, this.previous.depth, previousCamera!,
      );
    // タンパク質のケースは全画素を標本にし、全画素が履歴なしになるはずとして照合する。
    const proteinRejection = currentCase?.proteinMotion !== undefined;
    const result = await (proteinRejection
      ? motionReferenceOf(current, null, null, null, 1)
      : motionReferenceOf(
        current, forceNoHistory ? null : this.previous, forceNoHistory ? null : toPrevious,
        forceNoHistory ? null : gpuReprojected,
      ));
    this.previous = current;
    return {
      ...result,
      metrics: {
        ...result.metrics,
        sameFrameMismatchCount,
        fullNoHistorySurfacePixelCount,
        fullNoHistoryMismatchCount,
      },
      capture,
      frame,
    };
  }

  // 列を終える。前のフレームを捨てる。
  public reset(): void {
    this.previous = null;
  }
}

// ケース current の、写る画素が履歴なしになるはずの物体(ケースが持たなければ空)。
function rejectedObjectsAt(current: LabCase | null): readonly THREE.Object3D[] {
  return current?.rejectedMotionObjects?.() ?? [];
}

// ケース current の frame の実体。実体の口を持たないケースは、objects の中の Mesh と InstancedMesh の個体を、いまの
// 行列で静止した実体とみなす。
function entitiesAt(current: LabCase | null, frame: number): readonly LabMotionEntity[] {
  if (current === null) return [];
  if (current.motionEntities !== undefined) return current.motionEntities(frame);
  const entities: LabMotionEntity[] = [];
  const instanceMatrix = new THREE.Matrix4();
  for (const [rootIndex, root] of current.objects.entries()) {
    root.updateWorldMatrix(true, true);
    // 形状 geometry を matrix で置いた、静止した実体を足す。
    const add = (geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): void => {
      entities.push({ key: `static:${rootIndex}:${entities.length}`, kind: 'room', geometry, matrix, slot: null });
    };
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (!(object instanceof THREE.InstancedMesh)) {
        add(object.geometry, object.matrixWorld.clone());
        return;
      }
      for (let instanceId = 0; instanceId < object.count; instanceId++) {
        object.getMatrixAt(instanceId, instanceMatrix);
        // 空き枠は零行列で潰されている。
        if (instanceMatrix.determinant() === 0) continue;
        add(object.geometry, object.matrixWorld.clone().multiply(instanceMatrix));
      }
    });
  }
  return entities;
}

// frame のカメラを、描画の座標の原点を足し戻してケースの世界の座標へ置いた写し。
function worldCameraOf(frame: MotionReferenceFrame): THREE.PerspectiveCamera {
  const camera = frame.camera.clone();
  camera.position.add(frame.origin);
  camera.updateMatrixWorld(true);
  return camera;
}
