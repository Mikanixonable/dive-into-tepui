// ゼロ速度曲線の描画資源。1フレームぶんの宣言の列を、断面から抽出した曲線1本ずつへ反映する。
import * as THREE from 'three/webgpu';
import { GuideCurve, GuideCurveDisplay } from './guide-curve';
import type { CameraFrame } from '../../camera/camera-frame';

// このフレームに描くゼロ速度曲線1本。曲線の形が変わらないフレームでは同じオブジェクトを渡すこと。
export type ZeroVelocityDisplay = GuideCurveDisplay;

export class ZeroVelocityView {
  // 宣言の列と同じ並びの曲線。
  private readonly curves: GuideCurve[] = [];

  public constructor(private readonly scene: THREE.Scene) {}

  // このフレームに描く曲線を反映する。宣言に無い線は描画資源ごと解放されるので、何も描かない
  // フレームには空の列を渡す。
  public sync(displays: readonly ZeroVelocityDisplay[], camera: CameraFrame): void {
    // 曲線の本数を宣言の数へ合わせてから、1本ずつ同期する。
    while (this.curves.length > displays.length) this.disposeCurve(this.curves.pop()!);
    while (this.curves.length < displays.length) {
      const curve = new GuideCurve(displays[this.curves.length]!.style);
      this.scene.add(curve.line);
      this.curves.push(curve);
    }
    for (const [i, display] of displays.entries()) this.curves[i]!.sync(display, camera);
  }

  // 全ての曲線をシーンから外して破棄する。
  public dispose(): void {
    for (const curve of this.curves) this.disposeCurve(curve);
    this.curves.length = 0;
  }

  // 曲線1本をシーンから外して破棄する。
  private disposeCurve(curve: GuideCurve): void {
    curve.line.removeFromParent();
    curve.dispose();
  }
}
