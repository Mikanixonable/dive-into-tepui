// 2つの位置を結ぶ直線を描画する。頂点は対象(targetPos)相対座標のまま保持し、フローティング
// オリジンによる Object3D 平行移動でその ECI 位置へ置く。
import * as THREE from 'three/webgpu';
import { add, sub, v3, Vec3 } from '../../math/vec3';
import type { CameraFrame } from '../camera/camera-frame';
import { Curve, CurveKnots } from '../curve';
import { LineStyle } from '../line-style';

export class TargetRelativeLine {
  private readonly curve: Curve;
  public readonly line: THREE.Object3D;
  // 直近に描いた線分の基準点(ECI)。samplePoints の絶対座標化に使う。
  private origin: Vec3 | null = null;

  // 線を1本組む。style は最初のフレームの見た目で、以後は sync が渡す値で上書きされる。
  public constructor(style: LineStyle) {
    this.curve = new Curve(style);
    this.line = this.curve.object;
  }

  // このフレームに描く線分と見た目を反映する。selfPos と targetPos を結ぶ直線になる。
  public sync(selfPos: Vec3, targetPos: Vec3, style: LineStyle, camera: CameraFrame): void {
    this.curve.setStyle(style);
    const rel = sub(selfPos, targetPos);
    const knots: CurveKnots = {
      ts: [0, 1],
      positions: [0, 0, 0, rel.x, rel.y, rel.z],
      // 両端の接線を弦そのものにすると、3次エルミートが弦と一致する直線に落ちる。
      tangents: [rel.x, rel.y, rel.z, rel.x, rel.y, rel.z],
    };
    this.origin = targetPos;
    this.curve.setTransform(camera.floatingOrigin.RtoThreeV3(targetPos));
    this.curve.setHermiteCurve(knots, camera.camera, camera.viewport.height);
  }

  // 直近に描いた線分上のサンプル点列を ECI 絶対座標で返す(右クリックの当たり判定向け)。
  // 一度も sync していない間は空配列。
  public samplePoints(count: number): readonly Vec3[] {
    const origin = this.origin;
    if (origin === null) return [];
    const points: Vec3[] = [];
    const scratch = new THREE.Vector3();
    for (let i = 0; i <= count; i++) {
      this.curve.sampleAt(i / count, scratch);
      points.push(add(origin, v3(scratch.x, scratch.y, scratch.z)));
    }
    return points;
  }

  // 描画資源を解放する。以後この線は描けない。
  public dispose(): void {
    this.curve.dispose();
  }
}
