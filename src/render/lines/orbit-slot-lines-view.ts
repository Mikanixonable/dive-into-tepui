// 軌道標識の軌道線の描画資源。1フレームぶんの宣言の列を、標識1件ごとの曲線へ反映する。
// 描かれている点列を、宣言が添えた所属先の識別情報とともに返す。
import type * as THREE from 'three/webgpu';
import { GuideCurve, type GuideCurveDisplay } from '../celestial/orbit-guide/guide-curve';
import type { CameraFrame } from '../camera/camera-frame';
import type { Vec3 } from '../../math/vec3';

// このフレームに描く標識の軌道線1本。ownerKeys はこの線が属する対象(被選択物の id)。
export interface OrbitSlotLineDisplay extends GuideCurveDisplay {
  readonly key: string;
  readonly ownerKeys: readonly string[];
}

// 表示中の標識の軌道線1本の識別情報と、描かれている ECI 点列。
export interface VisibleOrbitSlotLine {
  readonly key: string;
  readonly ownerKeys: readonly string[];
  readonly points: readonly Vec3[];
}

export class OrbitSlotLinesView {
  // 線ごとの曲線。鍵は宣言の key(標識の id)。
  private readonly curves = new Map<string, GuideCurve>();
  // 直近に同期した宣言の列。
  private displays: readonly OrbitSlotLineDisplay[] = [];

  // 線を足す先のシーンを受ける。
  public constructor(private readonly scene: THREE.Scene) {}

  // このフレームに描く線を反映する。宣言に無い線は描画資源ごと解放されるので、
  // 何も描かないフレームには空の列を渡す。
  public sync(displays: readonly OrbitSlotLineDisplay[], camera: CameraFrame): void {
    if (displays !== this.displays) {
      this.retainOnly(displays);
      this.displays = displays;
    }
    for (const display of displays) this.curveFor(display).sync(display, camera);
  }

  // 表示中の線を所属先の識別情報付きで返す(1本も描いていない間は空)。sampleCount は
  // 1本を点列へ落とす分割数で、描かれる線の細かさとは独立。
  public visibleLines(sampleCount: number): readonly VisibleOrbitSlotLine[] {
    const visible: VisibleOrbitSlotLine[] = [];
    for (const display of this.displays) {
      // 折れ線として引けない2点未満の線は除く。
      const points = this.curves.get(display.key)?.samplePoints(sampleCount) ?? [];
      if (points.length < 2) continue;
      visible.push({ key: display.key, ownerKeys: display.ownerKeys, points });
    }
    return visible;
  }

  // 全ての曲線をシーンから外して破棄する。
  public dispose(): void {
    for (const curve of this.curves.values()) {
      curve.line.removeFromParent();
      curve.dispose();
    }
    this.curves.clear();
    this.displays = [];
  }

  // 宣言に対応する曲線。初めて出てきた鍵の線はここで組んでシーンへ加える。
  private curveFor(display: OrbitSlotLineDisplay): GuideCurve {
    const existing = this.curves.get(display.key);
    if (existing !== undefined) return existing;
    const curve = new GuideCurve(display.style);
    this.scene.add(curve.line);
    this.curves.set(display.key, curve);
    return curve;
  }

  // 宣言の列に現れない鍵の曲線を、シーンから外して破棄する。
  private retainOnly(displays: readonly OrbitSlotLineDisplay[]): void {
    const keys = new Set(displays.map((display) => display.key));
    for (const [key, curve] of this.curves) {
      if (keys.has(key)) continue;
      curve.line.removeFromParent();
      curve.dispose();
      this.curves.delete(key);
    }
  }
}
