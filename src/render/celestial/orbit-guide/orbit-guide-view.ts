// 軌道ガイド線の描画資源。1フレームぶんの宣言の列を、線1本ごとの曲線と進行方向マーカーへ
// 反映する。描かれている点列を、宣言が添えた識別情報とともに返す。
import * as THREE from 'three/webgpu';
import { GuideCurve, GuideCurveDisplay } from './guide-curve';
import { DirectionMarkers } from './direction-markers';
import { LINE_RENDER_ORDER } from '../../line-style';
import type { CurveColorSampler } from '../../curve';
import type { CameraFrame } from '../../camera/camera-frame';
import type { CatalogSystemId } from '../../../physics/orbit-catalog';
import type { Vec3 } from '../../../math/vec3';
import type { DirectionMarkerMode } from './direction-markers';

// マーカーの InstancedPool 容量。これを超えた個数のマーカーは溢れて描かれない。
const MARKER_POOL_CAPACITY = 3000;

// このフレームに描くガイド線1本。曲線と見た目に加えて、識別情報と進行方向マーカーの出し方を
// 持つ。曲線の形が変わらないフレームでは同じオブジェクトを渡すこと(点列を引き継ぐ鍵になる)。
export interface GuideLineDisplay extends GuideCurveDisplay {
  // 線を一意に指す鍵。
  readonly key: string;
  readonly familyId: string;
  readonly system: CatalogSystemId | null;
  readonly point: string | null;
  // 進行方向マーカーの出し方・色と、アニメーションの有無。
  readonly direction: DirectionMarkerMode;
  readonly animate: boolean;
  readonly markerColor: number;
  // 曲線1本に入る周回数。マーカーを並べる個数を決める。
  readonly revolutions: number;
  // 適応分割の頂点予算。収束しない曲線だけが指定する。
  readonly maxVertices?: number;
}

// 表示中のガイド線1本の識別情報と、描かれている ECI 点列。
export interface VisibleGuideLine {
  readonly key: string;
  readonly familyId: string;
  readonly system: CatalogSystemId | null;
  readonly point: string | null;
  readonly points: readonly Vec3[];
}

// 両端色(0xRRGGBB)を t∈[0,1] で内分した色。
function blendColors(colorStart: number, colorEnd: number, t: number): THREE.Color {
  return new THREE.Color().lerpColors(new THREE.Color(colorStart), new THREE.Color(colorEnd), t);
}

// 族の両端色を族内の位置 t で内分した代表色(0xRRGGBB)。
export function familyGradientColor(colorStart: number, colorEnd: number, t: number): number {
  return blendColors(colorStart, colorEnd, t).getHex();
}

// 族の両端色を族内の位置 t で内分した代表色を基準に、線の始点から終点まで明度を
// lightnessSwing だけ振る頂点カラー。
export function familyGradientColorAt(
  colorStart: number, colorEnd: number, t: number, lightnessSwing: number,
): CurveColorSampler {
  const base = blendColors(colorStart, colorEnd, t);
  return (curveT, out) => out.copy(base).offsetHSL(0, 0, (curveT - 0.5) * lightnessSwing);
}

export class OrbitGuideView {
  private readonly markers: DirectionMarkers;
  // 線ごとの曲線。鍵は宣言の key。
  private readonly curves = new Map<string, GuideCurve>();
  // 直近に同期した宣言の列。
  private displays: readonly GuideLineDisplay[] = [];

  // 線を足す先のシーンを受け、全ての線が共有するマーカーのプールを1本組む。
  public constructor(private readonly scene: THREE.Scene) {
    this.markers = new DirectionMarkers(scene, MARKER_POOL_CAPACITY, LINE_RENDER_ORDER.reference);
  }

  // このフレームに描くガイド線とマーカーを反映する。宣言に無い線は描画資源ごと解放されるので、
  // 何も描かないフレームには空の列を渡す。nowMs はこのフレームの実時刻 [ms]で、マーカーの
  // アニメーションはこれだけで進む。
  public sync(displays: readonly GuideLineDisplay[], camera: CameraFrame, nowMs: number): void {
    // 宣言の列が入れ替わったフレームだけ、線ごとの曲線の顔ぶれを合わせ直す。
    if (displays !== this.displays) {
      this.retainOnly(displays);
      this.displays = displays;
    }
    // マーカーは前のフレームの行列を保つので、線が無いフレームでも空のフレームを流して消す。
    this.markers.beginFrame();
    this.markers.cacheCamera(camera);
    for (const display of displays) {
      // マーカーは描かれている曲線から位置と接線を引くので、曲線を同期してから積む。
      const curve = this.curveFor(display);
      curve.sync(display, camera);
      this.markers.addLoop(
        curve, display.revolutions, display.direction, display.animate, nowMs, display.markerColor,
        camera.floatingOrigin,
      );
    }
    this.markers.endFrame();
  }

  // 表示中のガイド線を識別情報付きで返す(1本も描いていない間は空)。sampleCount は1本を点列へ
  // 落とす分割数で、描かれる線の細かさとは独立。
  public visibleLines(sampleCount: number): readonly VisibleGuideLine[] {
    const visible: VisibleGuideLine[] = [];
    for (const display of this.displays) {
      // 折れ線として引けない2点未満の線は除く。
      const points = this.curves.get(display.key)?.samplePoints(sampleCount) ?? [];
      if (points.length < 2) continue;
      visible.push({
        key: display.key, familyId: display.familyId, system: display.system,
        point: display.point, points,
      });
    }
    return visible;
  }

  // 全ての曲線とマーカーをシーンから外して破棄する。
  public dispose(): void {
    for (const curve of this.curves.values()) {
      curve.line.removeFromParent();
      curve.dispose();
    }
    this.curves.clear();
    this.displays = [];
    this.markers.dispose();
  }

  // 宣言に対応する曲線。初めて出てきた鍵の線はここで組んでシーンへ加える。
  private curveFor(display: GuideLineDisplay): GuideCurve {
    const existing = this.curves.get(display.key);
    if (existing !== undefined) return existing;
    const curve = new GuideCurve(display.style, display.maxVertices);
    this.scene.add(curve.line);
    this.curves.set(display.key, curve);
    return curve;
  }

  // 宣言の列に現れない鍵の曲線を、シーンから外して破棄する。
  private retainOnly(displays: readonly GuideLineDisplay[]): void {
    const keys = new Set(displays.map((display) => display.key));
    for (const [key, curve] of this.curves) {
      if (keys.has(key)) continue;
      curve.line.removeFromParent();
      curve.dispose();
      this.curves.delete(key);
    }
  }
}
