// 配置プレビューの表示資源。プレビュー楕円の線を所有し、そのフレームに宣言された表示値へ
// 同期する。
import { EllipseLine } from '../lines/ellipse-line';
import type * as THREE from 'three/webgpu';
import type { OrbitalElements } from '../../physics/elements';
import type { CameraFrame } from '../camera/camera-frame';
import type { LineStyle } from '../line-style';

export class ObjectPlacementPreviewView {
  private readonly ellipseLine: EllipseLine;

  // プレビュー楕円の線を1本組んでシーンへ載せる。style は最初のフレームの見た目。
  public constructor(scene: THREE.Scene, style: LineStyle) {
    this.ellipseLine = new EllipseLine(style);
    scene.add(this.ellipseLine.line);
  }

  // このフレームのプレビュー楕円を線へ反映する。elements が null のフレームは線が消える。
  public sync(elements: OrbitalElements | null, style: LineStyle, camera: CameraFrame): void {
    this.ellipseLine.sync(elements, style, camera);
  }

  // 楕円線をシーンから外して解放する。以後このプレビューは描けない。
  public dispose(): void {
    this.ellipseLine.line.removeFromParent();
    this.ellipseLine.dispose();
  }
}
