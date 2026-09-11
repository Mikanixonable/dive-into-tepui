// 天体1体の3D表示資源を所有し、毎フレーム渡される運動と表示設定を描画座標へ同期する。
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../../../render/gpu-timings';
import type { CelestialMotion } from '../../../physics/celestial-motion';
import { shapeSpheroidRadii, type CelestialBodyDef, type RingSystemDef } from '../../../physics/celestial-body-def';
import { orbitalElementsOf } from '../../../physics/elements';
import { len, sub, type Vec3 } from '../../../math/vec3';
import type { FloatingOrigin } from '../../camera/floating-origin';
import type { CameraFrame } from '../../camera/camera-frame';
import type { GraphicsSettingsData } from '../../graphics-settings';
import type { RenderStyle } from '../../render-style';
import type { RingMaterials } from '../ring';
import type { Albedo } from '../../celestial-albedo';
import type { CelestialSurfaceDiagnostics } from '../celestial-surface';
import type { AtmosphereClouds, AtmosphereOptics, AtmosphereCandidate } from '../../atmosphere';
import type { ShadowCumulus } from '../../pipeline/shadow/cloud-shadow-renderer';
import type { MarkerSlots } from '../../../game/marker/marker-slots';
import type { CelestialBody } from '../../../physics/celestial-body';
import { EllipseLine } from '../../lines/ellipse-line';
import { LINE_RENDER_ORDER, type LineStyle } from '../../line-style';

const SATELLITE_REFERENCE_LINE_COLOR = 0xaab3c0;
const PLANET_REFERENCE_LINE_COLOR = 0xffffff;
const PLANET_ORBIT_LINE_FADE_NEAR_DIST = 1e9;
const PLANET_ORBIT_LINE_FADE_FAR_DIST = 1e10;
const SATELLITE_ORBIT_LINE_FADE_NEAR_DIST = 5e8;
const SATELLITE_ORBIT_LINE_FADE_FAR_DIST = 1e9;
const REFERENCE_LINE_OPACITY = 0.3;

// 恒星が距離の二乗に反比例する光源として持つ値。
export interface StellarLight {
  readonly color: THREE.Color;
  readonly radiantIntensity: number;
}

// 照明・影・大気が読む天体1体の運動。楕円体の半軸・環の帯・大気の光学は分類ごとの宣言が
// 決めるので、CelestialBody の宣言をその定義そのままで受け直す。
export interface DefinedCelestialBody extends CelestialBody {
  readonly def: CelestialBodyDef;
}

// 他の天体の表示が恒星光を引くために必要な読み取り面。
export interface StellarLightSource {
  readonly motion: DefinedCelestialBody;
  readonly stellarLight: StellarLight;
}

// 天体1体の表示が、照らす源・遮る源・霞ませる源として答える面。
export interface CelestialIlluminationView {
  // 光源として扱うときの色つきボンドアルベド。反射光を配らない天体では null。
  readonly lightSourceAlbedo: Albedo | null;
  rings(motion: DefinedCelestialBody): RingSystemDef | null;
  cumulusShadowAt(
    motion: DefinedCelestialBody, floatingOrigin: FloatingOrigin, displayTime: number,
  ): ShadowCumulus | null;
  atmosphereCandidateAt(
    motion: DefinedCelestialBody, floatingOrigin: FloatingOrigin, displayTime: number,
    cameraPos: Vec3, radialScale: (center: Vec3) => number, graphics: GraphicsSettingsData,
  ): AtmosphereCandidate | null;
}

// 天体1体が、この1フレームの照明・影・大気へ差し出す源。visible はそのフレームに大気を
// 描いてよい天体か。
export interface CelestialIlluminationSource {
  readonly motion: DefinedCelestialBody;
  readonly view: CelestialIlluminationView;
  readonly visible: boolean;
}

export abstract class CelestialView {
  private referenceLineValue: EllipseLine | null = null;

  public get stellarLight(): StellarLight | null { return null; }
  public get atmosphereOptics(): AtmosphereOptics | null { return null; }
  public get lightSourceAlbedo(): Albedo | null { return null; }
  public get surfaceTextureUrl(): string | null { return null; }
  public get surfaceDiagnostics(): CelestialSurfaceDiagnostics | null { return null; }
  public rings(_motion: DefinedCelestialBody): RingSystemDef | null { return null; }

  public abstract build(
    motion: CelestialMotion, scene: THREE.Scene, ringMaterials: RingMaterials,
  ): void;
  public abstract sync(
    motion: CelestialMotion, displayTime: number, camera: CameraFrame,
    star: StellarLightSource | null,
    graphics: GraphicsSettingsData, style: RenderStyle, visible: boolean,
  ): void;

  // 大気の表示候補を、描画座標・画面密度・雲殻を含む renderer 入力へ変換する。
  public atmosphereCandidateAt(
    motion: DefinedCelestialBody, floatingOrigin: FloatingOrigin, displayTime: number,
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
    _motion: DefinedCelestialBody, _displayTime: number,
  ): AtmosphereClouds | null { return null; }

  // この天体が持つ動的な雲場を表示時刻へ焼く。
  public bakeClouds(_renderer: WebGPURenderer, _displayTime: number, _gpu?: GpuTimingSink): void {}

  public cumulusShadowAt(
    _motion: DefinedCelestialBody, _floatingOrigin: FloatingOrigin, _displayTime: number,
  ): ShadowCumulus | null { return null; }

  public syncMapOverlay(
    _motion: CelestialMotion, _displayTime: number, _camera: CameraFrame,
    _markers: MarkerSlots,
    _celestialBodies: readonly CelestialBody[], _visible: boolean,
  ): void {}

  // 表示時刻の接触軌道要素と、カメラからの距離で決まる濃さへ参照軌道線を同期する。
  public syncReferenceLine(
    motion: CelestialMotion, scene: THREE.Scene, displayTime: number, camera: CameraFrame, visible: boolean,
  ): void {
    // false は資源を残す非表示ではなく、参照線そのものが不要という宣言として扱う。
    if (!visible) {
      this.disposeReferenceLine();
      return;
    }
    const style = this.referenceLineStyle(motion, camera.position, displayTime);
    if (this.referenceLineValue === null) {
      this.referenceLineValue = new EllipseLine(style);
      scene.add(this.referenceLineValue.line);
    }
    // 資源を揃えた後、表示時刻の接触要素と距離フェードを毎フレーム反映する。
    const centerMotion = motion.primary;
    const elements = centerMotion === null
      ? null : orbitalElementsOf(motion.stateAt(displayTime), centerMotion, displayTime);
    this.referenceLineValue.sync(elements, style, camera);
  }

  // 参照線の見た目。色は天体の種別、不透明度はカメラからの距離フェードが決める。
  private referenceLineStyle(motion: CelestialMotion, cameraPos: Vec3, displayTime: number): LineStyle {
    return {
      color: motion.kind === 'satellite'
        ? SATELLITE_REFERENCE_LINE_COLOR : PLANET_REFERENCE_LINE_COLOR,
      opacity: this.referenceLineOpacityFrom(motion, cameraPos, displayTime),
      renderOrder: LINE_RENDER_ORDER.reference,
    };
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
  private referenceLineOpacityFrom(motion: CelestialMotion, cameraPos: Vec3, displayTime: number): number {
    const isSatellite = motion.kind === 'satellite';
    const nearDist = isSatellite
      ? SATELLITE_ORBIT_LINE_FADE_NEAR_DIST : PLANET_ORBIT_LINE_FADE_NEAR_DIST;
    const farDist = isSatellite
      ? SATELLITE_ORBIT_LINE_FADE_FAR_DIST : PLANET_ORBIT_LINE_FADE_FAR_DIST;
    const distance = len(sub(motion.stateAt(displayTime).r, cameraPos));
    return Math.min(1, Math.max(0, (distance - nearDist) / (farDist - nearDist)))
      * REFERENCE_LINE_OPACITY;
  }
}
