// 地球本体の見た目: 位置・自転角・太陽方向・表面アニメーションを表示時刻に同期し、
// 地球固有のマップ付随表示(静止軌道リングと GEO ラベル)も持つ。
import * as THREE from 'three/webgpu';
import { createEarth, type Earth as EarthMesh } from '../../render/earth';
import { CelestialMotion, PlanetMotion } from '../../physics/celestial-motion';
import { R_EARTH, SIDEREAL_DAY } from '../../physics/solar-system/constants';
import { EARTH_TEXTURES } from '../../render/earth';
import { scaledToBondAlbedo, type Albedo } from '../../render/celestial-albedo';
import type { AtmosphereOptics } from '../../render/atmosphere';
import { CelestialBody } from '../../physics/celestial-body';
import { OrbitalElements } from '../../physics/elements';
import { kinematicState } from '../../physics/kinematic-state';
import { isOccluded } from '../../physics/occlusion';
import { add, len, scale, sub, v3, type Vec3 } from '../../math/vec3';
import { LINE_RENDER_ORDER } from '../../render/line-style';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../camera/floating-origin';
import * as C from '../const';
import { OrbitLine } from '../lines/orbit-line';
import type { MarkerManager } from '../marker/marker-manager';
import { CelestialEntity } from './celestial-entity';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { RenderStyle } from '../../render/render-style';

// 静止軌道リングと GEO ラベルは 240,000km で薄れ始め 720,000km で消える。
const GEO_FADE_NEAR_DIST = 2.4e8;
const GEO_FADE_SPAN = 4.8e8;

export class Earth extends CelestialEntity {
  private readonly earth: EarthMesh = createEarth();
  // 自転初期位相 [rad]。起動時の乱数かセーブの復元値が入る。
  private readonly phase0: number;
  // 静止軌道高度の参照リング。実在の衛星や特定経度を表すものではない定数。
  private readonly geoLine = new OrbitLine({ color: 0x8b93a0, opacity: 0.2, renderOrder: LINE_RENDER_ORDER.reference });
  private readonly geoElements: OrbitalElements;

  constructor(motion: PlanetMotion, name: string, spinPhase0: number, atmosphereOptics: AtmosphereOptics | null) {
    super(motion, name, 'planet', atmosphereOptics);
    this.phase0 = spinPhase0;
    const def = motion.def;
    const earthCelestialBody: CelestialBody = {
      id: motion.id, mu: def.mu, radius: def.radius,
      state: kinematicState(0, v3(0, 0, 0), v3(0, 0, 0)), accel: v3(), degree2: null, atmosphere: null,
      isStar: false,
    };
    this.geoElements = {
      a: def.radius + 35786e3, e: 1e-6, p: def.radius + 35786e3, incDeg: 0, period: 86164,
      hHat: v3(0, 1, 0), pHat: v3(1, 0, 0), qHat: v3(0, 0, -1), center: earthCelestialBody,
    };
  }

  // 地表・雲の合成テクスチャから測った色み(render/earth.ts の合成と同じ測光)。
  get lightSourceAlbedo(): Albedo | null {
    return scaledToBondAlbedo(EARTH_TEXTURES.averageHue, EARTH_TEXTURES.bondAlbedo);
  }

  get surfaceTextureUrl(): string | null { return EARTH_TEXTURES.surfaceUrl; }

  // 地球メッシュと静止軌道リングをシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    scene.add(this.earth.group);
    scene.add(this.geoLine.line);
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

  // 静止軌道リングと GEO ラベルを、このフレームの表示状態に同期する。visible は所有者の判断
  // (マップ視点 かつ 静止軌道トグル ON)。
  override syncMapOverlay(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem,
    markerManager: MarkerManager | null, celestialBodies: readonly CelestialBody[], visible: boolean,
  ): void {
    this.geoLine.sync(visible ? this.geoElements : null, fo, cameraSystem.activeCamera);
    const earthPos = this.motion.stateAt(displayTime).r;
    const distToEarth = len(sub(earthPos, cameraSystem.activeCameraPos));
    const geoFade = 1.0 - Math.min(1, Math.max(0, (distToEarth - GEO_FADE_NEAR_DIST) / GEO_FADE_SPAN));
    if (visible) this.geoLine.setOpacity(0.55 * geoFade);
    this.syncGeoLabels(earthPos, geoFade, cameraSystem, markerManager, celestialBodies, visible);
  }

  // 静止軌道に沿った半透明の小さなテキスト文字ラベルを描画する。
  private syncGeoLabels(
    earthPos: Vec3, geoFade: number, cameraSystem: CameraSystem,
    markerManager: MarkerManager | null, celestialBodies: readonly CelestialBody[], visible: boolean,
  ): void {
    const keys = ['geolabel-0', 'geolabel-1', 'geolabel-2', 'geolabel-3'];
    if (!markerManager) return;
    // ラベルはリングよりやや濃く残して視認性を保つ。
    const labelOpacity = 0.90 * geoFade;
    if (!visible || labelOpacity <= 0.02) {
      for (const key of keys) markerManager.hide(key);
      return;
    }

    const cameraPos = cameraSystem.activeCameraPos;
    const project = cameraSystem.activeCameraProjection;
    const rGeo = this.geoElements.a;
    const pHat = this.geoElements.pHat;
    const qHat = this.geoElements.qHat;

    const numLabels = 1;
    for (let i = 1; i < 4; i++) markerManager.hide(keys[i]!);
    for (let i = 0; i < numLabels; i++) {
      const key = keys[i]!;
      const theta = Math.PI / 4;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      const pos = add(earthPos, add(scale(pHat, rGeo * cosT), scale(qHat, rGeo * sinT)));

      const p0 = project(pos);
      if (!p0.front || isOccluded(cameraPos, pos, celestialBodies)) {
        markerManager.hide(key);
        continue;
      }

      markerManager.set(
        key,
        'mk-geolabel',
        'GEO (35,786km)',
        p0.x,
        p0.y,
        p0.front,
        '',
        labelOpacity,
        undefined,
        undefined,
        false,
        true,
        C.MARKER_PRIORITY.ORBITAL_NODE,
        len(sub(pos, cameraPos)),
      );
    }
  }

  // 地球メッシュと静止軌道リングを解放する。
  dispose(): void {
    this.earth.dispose();
    this.geoLine.line.removeFromParent();
    this.geoLine.dispose();
  }
}
