// 論理フレームの深度・カメラ・実体から動きの参照と検算を作る。
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
  // 深度の参照の写像との自己検算と、GPU の深度による参照の再投影との差も求める。
  public async frame(frame: number, compareDepth: boolean): Promise<MotionVectorFrameRecord> {
    this.view.setFrame(frame);
    const capture = await this.view.captureSettled(`motion reference ${frame}`);
    const currentCase = this.view.currentCase;
    const current: MotionReferenceFrame = {
      depth: await this.view.readFloat('depth'),
      camera: this.view.camera.clone(),
      origin: currentCase?.renderOrigin?.() ?? new THREE.Vector3(),
      entities: entitiesAt(currentCase, frame),
    };
    const previousCamera = this.previous === null ? null : worldCameraOf(this.previous);
    const currentCamera = worldCameraOf(current);
    const toPrevious = compareDepth && previousCamera !== null
      ? reprojectionMatrixBetween(currentCamera, previousCamera)
      : null;
    const gpuReprojected = toPrevious === null || this.previous === null ? null
      : reprojectedPixels(current.depth, currentCamera, this.previous.depth, previousCamera!);
    const result = motionReferenceOf(current, this.previous, toPrevious, gpuReprojected);
    this.previous = current;
    return { ...result, capture, frame };
  }

  // 列を終える。前のフレームを捨てる。
  public reset(): void {
    this.previous = null;
  }
}

// ケース current の frame の実体。実体の口を持たないケースは、objects の中の(InstancedMesh でない)Mesh を、いまの
// matrixWorld で静止した実体とみなす。
function entitiesAt(current: LabCase | null, frame: number): readonly LabMotionEntity[] {
  if (current === null) return [];
  if (current.motionEntities !== undefined) return current.motionEntities(frame);
  const entities: LabMotionEntity[] = [];
  for (const [rootIndex, root] of current.objects.entries()) {
    root.updateWorldMatrix(true, true);
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh) return;
      entities.push({
        key: `static:${rootIndex}:${entities.length}`,
        kind: 'room',
        geometry: object.geometry,
        matrix: object.matrixWorld.clone(),
        slot: null,
      });
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
