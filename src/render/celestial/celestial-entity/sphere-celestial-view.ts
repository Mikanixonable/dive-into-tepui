// 表面・経緯度グリッド・環を持つ球天体の見た目を、実 ECI 位置・実半径・自転姿勢で描く。
// 見かけ直径が閾値未満のフレームは球と環を隠す。
import * as THREE from 'three/webgpu';
import { shapeAxes, type RingSystemDef } from '../../../physics/celestial-body-def';
import { spinOrientation } from '../../../physics/body-orientation';
import { apparentSizePx } from '../../../math/projection';
import { showsPhysicalSphere } from '../screen-lod';
import { BodyGraticule } from '../body-graticule';
import { RingView } from '../ring-view';
import { CelestialView, type DefinedCelestialBody, type StellarLightSource } from './celestial-view';
import type { CelestialMotion } from '../../../physics/celestial-motion';
import type { Vec3 } from '../../../math/vec3';
import type { CameraFrame } from '../../camera/camera-frame';
import type { CelestialSurfaceDiagnostics, CelestialSurfaceLike } from '../celestial-surface';
import type { LineOverlay } from '../line-overlay';
import type { AtmosphereOptics } from '../../atmosphere';
import type { Albedo } from '../../celestial-albedo';
import type { GraphicsSettingsData } from '../../graphics-settings';
import type { RenderStyle } from '../../render-style';
import type { RingMaterials } from '../ring';

export class SphereCelestialView extends CelestialView {
  // 位置と自転姿勢を載せる入れ物。扁平のスケールは子の shapeGroup が持つので、ここの直下には
  // 実寸 [m] の頂点を持つ表示物を置ける。
  protected readonly group = new THREE.Group();
  // 扁平のスケールを持つ入れ物。半径 1 の単位形状で作った表示物はここへ置く。
  protected readonly shapeGroup = new THREE.Group();
  // 自転姿勢が乗る前のローカル半軸 [m]。物理定義から build 時に作る描画用キャッシュ。
  protected readonly axes = new THREE.Vector3();
  // 本体と環を合わせた外半径 [m]。見かけ直径の判定に使う、build 時に作る描画用キャッシュ。
  private outerRadius = 0;
  private ring: RingView | null = null;
  // 模式図スタイルでだけ見せる経緯度グリッド。
  private readonly graticule = new BodyGraticule();

  // surface は実体の表面、surfaceMarkings は模式図でだけ見せる天体固有の表面ライン。
  public constructor(
    protected readonly surface: CelestialSurfaceLike,
    private readonly optics: AtmosphereOptics | null = null,
    private readonly surfaceMarkings: LineOverlay | null = null,
  ) { super(); }

  public override get atmosphereOptics(): AtmosphereOptics | null { return this.optics; }

  public override get lightSourceAlbedo(): Albedo | null { return this.surface.photometry?.lightSourceAlbedo ?? null; }

  public override get surfaceTextureUrl(): string | null { return this.surface.textureUrl; }

  public override get surfaceDiagnostics(): CelestialSurfaceDiagnostics | null { return this.surface.diagnostics; }

  // 定義に環がある天体だけ、その固定定義を返す。
  public override rings(motion: DefinedCelestialBody): RingSystemDef | null {
    return 'rings' in motion.def ? motion.def.rings ?? null : null;
  }

  // 表面・経緯度グリッド・表面ラインと環をシーンへ一度だけ登録する。
  public build(motion: CelestialMotion, scene: THREE.Scene, ringMaterials: RingMaterials): void {
    // 本体形状と環の外半径は定義だけで決まるため、構築時に焼いて同期時に再利用する。
    const def = motion.def;
    const axes = shapeAxes(def.radius, 'shape' in def ? def.shape : undefined);
    this.axes.set(axes.x, axes.y, axes.z);
    const rings = this.rings(motion);
    this.outerRadius = rings === null
      ? def.radius
      : rings.bands.reduce((maxRadius, band) => Math.max(maxRadius, band.outerRadius), def.radius);
    // 本体に追従する資源は group、独立姿勢を持つ環は scene へ登録する。
    this.surface.addTo(this.shapeGroup);
    this.graticule.addTo(this.shapeGroup);
    this.surfaceMarkings?.addTo(this.shapeGroup);
    this.group.add(this.shapeGroup);
    scene.add(this.group);
    if (rings !== null) {
      this.ring = new RingView(rings, def.radius, this.group.renderOrder + 1, ringMaterials);
      scene.add(this.ring.group);
    }
  }

  // displayTime 時点の位置へ同期する。見かけ直径が閾値未満なら球と環を隠す。
  public sync(
    motion: CelestialMotion, displayTime: number, camera: CameraFrame,
    star: StellarLightSource | null,
    graphics: GraphicsSettingsData, style: RenderStyle, visible: boolean,
  ): void {
    // category 非表示は本体と独立した環にも同時に反映する。
    this.group.visible = visible;
    if (!visible) {
      this.ring?.hide();
      this.syncHidden();
      return;
    }
    const pos = motion.stateAt(displayTime).r;
    const apparentDiameterPx = apparentSizePx(
      2 * this.outerRadius, camera.radialScale(pos),
    ) * graphics.lodBias;
    if (!showsPhysicalSphere(apparentDiameterPx)) {
      this.hidePhysical();
      this.syncUnresolved(motion, pos, displayTime, camera, star);
      return;
    }
    // 表面の分割段と模式図の重ね書き。
    this.surface.syncLod(apparentDiameterPx);
    this.graticule.setVisible(style === 'schematic');
    this.surfaceMarkings?.setVisible(style === 'schematic');
    // 位置・扁平・自転姿勢。
    const orientation = motion.orientationAt(displayTime);
    const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
    this.group.position.copy(camera.floatingOrigin.RtoThreeV3(pos));
    this.shapeGroup.scale.copy(this.axes);
    if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    this.syncResolved(motion, apparentDiameterPx, displayTime, camera, star, graphics, style);
    // 環へ本体と同じ位置と見た目を渡す。
    this.ring?.sync(
      this.group.position,
      orientation === null ? null : orientation.axis,
      pos,
      camera.scale,
      graphics,
      style,
    );
  }

  // 本体ごと非表示にしたフレームで、派生が group の外に足した表示物を隠す。
  protected syncHidden(): void {}

  // 見かけ直径が閾値未満で実体と環を畳んだフレームに、派生が足した表示物を同期する。
  // pos は displayTime 時点の ECI 位置 [m]。
  protected syncUnresolved(
    _motion: CelestialMotion, _pos: Vec3, _displayTime: number, _camera: CameraFrame,
    _star: StellarLightSource | null,
  ): void {}

  // 実体を描くフレームに、派生が足した表示物を同期する。group の位置・自転姿勢と shapeGroup の
  // 扁平は、呼ばれた時点でこのフレームの値に揃っている。
  protected syncResolved(
    _motion: CelestialMotion, _apparentDiameterPx: number, _displayTime: number, _camera: CameraFrame,
    _star: StellarLightSource | null, _graphics: GraphicsSettingsData, _style: RenderStyle,
  ): void {}

  // 表面・グリッド・表面ライン・環を隠す。
  private hidePhysical(): void {
    this.surface.hide();
    this.graticule.setVisible(false);
    this.surfaceMarkings?.setVisible(false);
    this.ring?.hide();
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
