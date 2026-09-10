// 天体1体の3D表示資源を所有し、毎フレーム渡される運動と表示設定を描画座標へ同期する。
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../../../render/gpu-timings';
import type { CelestialMotion } from '../../../physics/celestial-motion';
import { shapeSpheroidRadii, type RingSystemDef } from '../../../physics/celestial-body-def';
import { orbitalElementsOf } from '../../../physics/elements';
import { len, sub, type Vec3 } from '../../../math/vec3';
import type { FloatingOrigin } from '../../camera/floating-origin';
import type { CameraSystem } from '../../camera/camera-system';
import type { GraphicsSettingsData } from '../../../render/graphics-settings';
import type { RenderStyle } from '../../../render/render-style';
import type { RingMaterials } from '../../../render/ring';
import type { Albedo } from '../../../render/celestial-albedo';
import type { AtmosphereClouds, AtmosphereOptics, AtmosphereCandidate } from '../../../render/atmosphere';
import type { ShadowCumulus } from '../../../render/pipeline/shadow/cloud-shadow-renderer';
import type { MarkerSlots } from '../../marker/marker-slots';
import type { CelestialBody } from '../../../physics/celestial-body';
import { EllipseLine } from '../../lines/ellipse-line';
import { LINE_RENDER_ORDER } from '../../../render/line-style';

const SATELLITE_REFERENCE_LINE_COLOR = 0xaab3c0;
const PLANET_REFERENCE_LINE_COLOR = 0xffffff;
const PLANET_ORBIT_LINE_FADE_NEAR_DIST = 1e9;
const PLANET_ORBIT_LINE_FADE_FAR_DIST = 1e10;
const SATELLITE_ORBIT_LINE_FADE_NEAR_DIST = 5e8;
const SATELLITE_ORBIT_LINE_FADE_FAR_DIST = 1e9;
const REFERENCE_LINE_OPACITY = 0.3;

// 恒星が距離の二乗に反比例する光源として持つ値。
export type StellarLight = {
  readonly color: THREE.Color;
  readonly radiantIntensity: number;
};

// 他の天体の表示が恒星光を引くために必要な読み取り面。
export type StellarLightSource = {
  readonly motion: CelestialMotion;
  readonly stellarLight: StellarLight;
};

export abstract class CelestialView {
  private referenceLineValue: EllipseLine | null = null;

  public get stellarLight(): StellarLight | null { return null; }
  public get atmosphereOptics(): AtmosphereOptics | null { return null; }
  public get lightSourceAlbedo(): Albedo | null { return null; }
  public get surfaceTextureUrl(): string | null { return null; }
  public rings(_motion: CelestialMotion): RingSystemDef | null { return null; }

  public abstract build(
    motion: CelestialMotion, scene: THREE.Scene, ringMaterials: RingMaterials,
  ): void;
  public abstract sync(
    motion: CelestialMotion, floatingOrigin: FloatingOrigin, displayTime: number,
    cameraSystem: CameraSystem, star: StellarLightSource | null,
    graphics: GraphicsSettingsData, style: RenderStyle, visible: boolean,
  ): void;

  // 大気の表示候補を、描画座標・画面密度・雲殻を含む renderer 入力へ変換する。
  public atmosphereCandidateAt(
    motion: CelestialMotion, floatingOrigin: FloatingOrigin, displayTime: number,
    cameraPos: Vec3, radialScale: (center: Vec3) => number,
    graphics: GraphicsSettingsData,
  ): AtmosphereCandidate | null {
    // 大気を持たない具象は候補を作らず、renderer 側へ空の殻を漏らさない。
    const optics = this.atmosphereOptics;
    if (optics === null) return null;
    const center = motion.stateAt(displayTime).r;
    const def = motion.def;
    const radii = shapeSpheroidRadii(def.radius, 'shape' in def ? def.shape : undefined);
    const axis = motion.orientationAt(displayTime)?.axis ?? null;
    // 形状・雲・画面密度を同じ表示時刻とカメラ基準でまとめる。
    return {
      body: {
        center: floatingOrigin.RtoThreeV3(center),
        surfaceRadius: radii.equatorRadius,
        polarAxis: axis === null
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(axis.x, axis.y, axis.z).normalize(),
        polarRatio: radii.polarRadius / radii.equatorRadius,
        optics,
        clouds: graphics.clouds ? this.atmosphereCloudsAt(motion, displayTime) : null,
      },
      distance: len(sub(cameraPos, center)),
      metersPerPixel: radialScale(center),
    };
  }

  public atmosphereCloudsAt(
    _motion: CelestialMotion, _displayTime: number,
  ): AtmosphereClouds | null { return null; }

  // この天体が持つ動的な雲場を表示時刻へ焼く。
  public bakeClouds(_renderer: WebGPURenderer, _displayTime: number, _gpu?: GpuTimingSink): void {}

  public cumulusShadowAt(
    _motion: CelestialMotion, _floatingOrigin: FloatingOrigin, _displayTime: number,
  ): ShadowCumulus | null { return null; }

  public syncMapOverlay(
    _motion: CelestialMotion, _floatingOrigin: FloatingOrigin, _displayTime: number,
    _cameraSystem: CameraSystem, _markers: MarkerSlots,
    _celestialBodies: readonly CelestialBody[], _visible: boolean,
  ): void {}

  // 表示時刻の接触軌道要素と、カメラからの距離で決まる濃さへ参照軌道線を同期する。
  public syncReferenceLine(
    motion: CelestialMotion, scene: THREE.Scene, simTime: number, floatingOrigin: FloatingOrigin,
    camera: THREE.Camera, cameraPos: Vec3, visible: boolean,
  ): void {
    // false は資源を残す非表示ではなく、参照線そのものが不要という宣言として扱う。
    if (!visible) {
      this.disposeReferenceLine();
      return;
    }
    const opacity = this.referenceLineOpacityFrom(motion, cameraPos, simTime);
    if (this.referenceLineValue === null) {
      const color = motion.kind === 'satellite'
        ? SATELLITE_REFERENCE_LINE_COLOR : PLANET_REFERENCE_LINE_COLOR;
      this.referenceLineValue = new EllipseLine({
        color, opacity, renderOrder: LINE_RENDER_ORDER.reference,
      });
      scene.add(this.referenceLineValue.line);
    }
    // 資源を揃えた後、表示時刻の接触要素と距離フェードを毎フレーム反映する。
    const centerMotion = motion.primary;
    const elements = centerMotion === null
      ? null : orbitalElementsOf(motion.stateAt(simTime), centerMotion, simTime);
    if (elements === null) this.referenceLineValue.hide();
    else this.referenceLineValue.sync(elements, floatingOrigin, camera);
    this.referenceLineValue.setOpacity(opacity);
  }

  // 現在描画している参照軌道線を、当たり判定用の ECI 点列として読み出す。
  public referenceLineSamples(count: number): readonly Vec3[] {
    return this.referenceLineValue?.samplePoints(count) ?? [];
  }

  // 参照軌道線の THREE 資源を、存在する場合だけ解放する。
  private disposeReferenceLine(): void {
    if (this.referenceLineValue === null) return;
    this.referenceLineValue.line.removeFromParent();
    this.referenceLineValue.dispose();
    this.referenceLineValue = null;
  }

  // 参照線と具象 View の資源をまとめて破棄する。
  public dispose(): void {
    this.disposeReferenceLine();
    this.disposeContents();
  }

  protected abstract disposeContents(): void;

  // 天体種別ごとの距離帯を使い、参照線の不透明度を連続的に求める。
  private referenceLineOpacityFrom(motion: CelestialMotion, cameraPos: Vec3, simTime: number): number {
    const isSatellite = motion.kind === 'satellite';
    const nearDist = isSatellite
      ? SATELLITE_ORBIT_LINE_FADE_NEAR_DIST : PLANET_ORBIT_LINE_FADE_NEAR_DIST;
    const farDist = isSatellite
      ? SATELLITE_ORBIT_LINE_FADE_FAR_DIST : PLANET_ORBIT_LINE_FADE_FAR_DIST;
    const distance = len(sub(motion.stateAt(simTime).r, cameraPos));
    return Math.min(1, Math.max(0, (distance - nearDist) / (farDist - nearDist)))
      * REFERENCE_LINE_OPACITY;
  }
}
