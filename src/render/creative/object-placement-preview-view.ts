// 配置プレビューの表示資源。プレビュー楕円の線と ▷ マーカーを所有し、そのフレームに宣言された
// 表示値へ同期する。
import { COLOR_MARKER_ALLY, ENTITY_GLYPH } from '../../game/marker/marker-identity';
import { EllipseLine } from '../lines/ellipse-line';
import type * as THREE from 'three/webgpu';
import type { Vec3 } from '../../math/vec3';
import type { OrbitalElements } from '../../physics/elements';
import type { MarkerSlots } from '../../game/marker/marker-slots';
import type { CameraFrame } from '../camera/camera-frame';
import type { LineStyle } from '../line-style';

const MARKER_KEY = 'creative-preview';

// ▷ マーカーの、そのフレームの表示。位置を示すか、すぐ消すか、透明化して畳むか。
export type ObjectPlacementPreviewMarker =
  | { readonly kind: 'shown'; readonly pos: Vec3 } // ECI 位置
  | { readonly kind: 'hidden' }
  | { readonly kind: 'fadedOut' };

export class ObjectPlacementPreviewView {
  private readonly ellipseLine: EllipseLine;

  // プレビュー楕円の線を1本組んでシーンへ載せる。style は最初のフレームの見た目。
  public constructor(
    scene: THREE.Scene,
    private readonly markers: MarkerSlots,
    style: LineStyle,
  ) {
    this.ellipseLine = new EllipseLine(style);
    scene.add(this.ellipseLine.line);
  }

  // このフレームのプレビューを楕円線と ▷ マーカーへ反映する。elements が null のフレームは
  // 線が消える。
  public sync(
    elements: OrbitalElements | null, marker: ObjectPlacementPreviewMarker,
    style: LineStyle, camera: CameraFrame,
  ): void {
    this.ellipseLine.sync(elements, style, camera);
    // ▷ マーカーは、位置を示すフレームだけ投影する。
    switch (marker.kind) {
      case 'shown':
        this.markers.setPosition(
          MARKER_KEY, 'mk-self', ENTITY_GLYPH.preview, marker.pos, camera.project,
          'PREVIEW', 1, COLOR_MARKER_ALLY, 0, false, false, undefined, camera.position,
        );
        return;
      case 'hidden':
        this.markers.hide(MARKER_KEY);
        return;
      case 'fadedOut':
        this.markers.fadeOut(MARKER_KEY);
        return;
    }
  }

  // 楕円線をシーンから外して解放する。以後このプレビューは描けない。
  public dispose(): void {
    this.ellipseLine.line.removeFromParent();
    this.ellipseLine.dispose();
  }
}
