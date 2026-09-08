// 「テクスチャ球」で済む天体(月・木星など)の見た目を実 ECI 位置・実半径で描く。
// 見かけ直径が閾値未満なら球自体を描かない。
import * as THREE from 'three/webgpu';
import type { CelestialMotion } from '../../../physics/celestial-motion';
import { shapeAxes, type RingSystemDef } from '../../../physics/celestial-body-def';
import type { CameraSystem } from '../../camera/camera-system';
import type { FloatingOrigin } from '../../camera/floating-origin';
import { spinOrientation } from '../../../physics/body-orientation';
import { apparentSizePx } from '../../../math/projection';
import { showsPhysicalSphere } from '../../../render/screen-lod';
import { CelestialSurface } from '../../../render/celestial-surface';
import { BodyGraticule } from '../../../render/body-graticule';
import type { LineOverlay } from '../../../render/line-overlay';
import type { AtmosphereOptics } from '../../../render/atmosphere';
import type { Albedo } from '../../../render/celestial-albedo';
import type { GraphicsSettingsData } from '../../../render/graphics-settings';
import type { RenderStyle } from '../../../render/render-style';
import type { RingMaterials } from '../../../render/ring';
import { CelestialView, type StellarLightSource } from './celestial-view';
import { RingView } from '../../../render/ring-view';

export class SphereCelestialView extends CelestialView {
  private readonly group = new THREE.Group();
  private readonly axes = new THREE.Vector3();
  private outerRadius = 0;
  private ring: RingView | null = null;
  private readonly graticule = new BodyGraticule();

  public constructor(
    private readonly surface: CelestialSurface,
    private readonly optics: AtmosphereOptics | null = null,
    private readonly surfaceMarkings: LineOverlay | null = null,
  ) { super(); }

  public override get atmosphereOptics(): AtmosphereOptics | null { return this.optics; }

  public get lightSourceAlbedo(): Albedo | null { return this.surface.photometry?.lightSourceAlbedo ?? null; }
  public get surfaceTextureUrl(): string | null { return this.surface.textureUrl; }
  public override rings(motion: CelestialMotion): RingSystemDef | null {
    return 'rings' in motion.def ? motion.def.rings ?? null : null;
  }

  // 表面メッシュと環をシーンへ一度だけ登録する。
  public build(motion: CelestialMotion, scene: THREE.Scene, ringMaterials: RingMaterials): void {
    const def = motion.def;
    const axes = shapeAxes(def.radius, 'shape' in def ? def.shape : undefined);
    this.axes.set(axes.x, axes.y, axes.z);
    const rings = this.rings(motion);
    this.outerRadius = rings === null
      ? def.radius
      : rings.bands.reduce((maxRadius, band) => Math.max(maxRadius, band.outerRadius), def.radius);
    this.surface.addTo(this.group);
    this.graticule.addTo(this.group);
    this.surfaceMarkings?.addTo(this.group);
    scene.add(this.group);
    if (rings !== null) {
      this.ring = new RingView(rings, def.radius, this.group.renderOrder + 1, ringMaterials);
      scene.add(this.ring.group);
    }
  }

  public setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.ring?.setVisible(visible);
  }

  // displayTime 時点の位置へ同期する。見かけ直径が閾値未満なら球自体(と環)を描かない。
  public sync(
    motion: CelestialMotion, fo: FloatingOrigin, displayTime: number,
    cameraSystem: CameraSystem, _star: StellarLightSource | null,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void {
    if (!this.group.visible) return;
    const pos = motion.stateAt(displayTime).r;
    const apparentDiameterPx = apparentSizePx(
      2 * this.outerRadius, cameraSystem.activeCameraRadialScale(pos),
    ) * graphics.lodBias;
    if (!showsPhysicalSphere(apparentDiameterPx)) {
      this.hidePhysical();
      return;
    }
    this.surface.syncLod(apparentDiameterPx);
    this.graticule.setVisible(style === 'schematic');
    this.surfaceMarkings?.setVisible(style === 'schematic');
    this.group.position.copy(fo.RtoThreeV3(pos));
    this.group.scale.copy(this.axes);
    const orientation = motion.orientationAt(displayTime);
    const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
    if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    this.ring?.sync(
      this.group.position,
      orientation === null ? null : orientation.axis,
      pos,
      cameraSystem.activeCameraScale,
      graphics,
      style,
    );
  }

  // 見かけ直径が閾値未満のときの共通後始末: 表面と環を隠す。
  private hidePhysical(): void {
    this.surface.hide();
    this.graticule.setVisible(false);
    this.surfaceMarkings?.setVisible(false);
    this.ring?.setVisible(false);
  }

  // 表面とグリッドと表面ラインと環を解放し、group を親から外す。
  protected disposeContents(): void {
    this.group.removeFromParent();
    this.surface.dispose();
    this.graticule.dispose();
    this.surfaceMarkings?.dispose();
    this.ring?.dispose();
  }
}
