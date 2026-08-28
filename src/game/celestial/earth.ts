// 地球本体の見た目: 位置・自転角・太陽方向・表面アニメーションを表示時刻に同期する。
import * as THREE from 'three/webgpu';
import { createEarth, type Earth as EarthMesh } from '../../render/earth';
import { CelestialMotion, PlanetMotion } from '../../physics/celestial-motion';
import { R_EARTH, SIDEREAL_DAY } from '../../physics/solar-system/constants';
import { EARTH_TEXTURES } from '../../render/celestial-textures';
import { scaledToBondAlbedo, type Albedo } from '../../render/celestial-albedo';
import type { AtmosphereOptics } from '../../render/atmosphere';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../camera/floating-origin';
import { CelestialEntity } from './celestial-entity';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { RenderStyle } from '../../render/render-style';

export class Earth extends CelestialEntity {
  private readonly earth: EarthMesh = createEarth();
  // 自転初期位相 [rad]。起動時の乱数かセーブの復元値が入る。
  private readonly phase0: number;

  constructor(motion: PlanetMotion, name: string, spinPhase0: number, atmosphereOptics: AtmosphereOptics | null) {
    super(motion, name, 'planet', atmosphereOptics);
    this.phase0 = spinPhase0;
  }

  // 地表・雲の合成テクスチャから測った色み(render/earth.ts の合成と同じ測光)。
  get lightSourceAlbedo(): Albedo | null {
    return scaledToBondAlbedo(EARTH_TEXTURES.averageHue, EARTH_TEXTURES.bondAlbedo);
  }

  get surfaceTextureUrl(): string | null { return EARTH_TEXTURES.surfaceUrl; }

  // 地球メッシュをシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    scene.add(this.earth.group);
  }

  setVisible(visible: boolean): void {
    this.earth.group.visible = visible;
  }

  // 自転初期位相 [rad](セーブ用)。
  spinPhase0(): number { return this.phase0; }

  // displayTime 時点の位置・自転角・太陽方向・表面アニメーション・地表LODへ同期する。
  sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, _star: CelestialMotion | null,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void {
    if (!this.earth.group.visible) return;
    const pos = this.motion.stateAt(displayTime).r;
    this.earth.group.position.copy(fo.RtoThreeV3(pos));
    this.earth.setRotation(this.phase0 + (2 * Math.PI * displayTime) / SIDEREAL_DAY);
    const metersPerPixel = cameraSystem.activeCameraScale(pos);
    this.earth.setAuroraVisible(graphics.aurora);
    this.earth.setCloudsVisible(graphics.clouds);
    this.earth.setGraticuleVisible(style === 'schematic');
    this.earth.setCoastlineVisible(style === 'schematic');
    this.earth.syncSurfaceLod(this.lodApparentDiameterPx(2 * R_EARTH, metersPerPixel, graphics));
    this.earth.tick(displayTime);
  }

  // 地球メッシュ一式を解放する。
  dispose(): void {
    this.earth.dispose();
  }
}
