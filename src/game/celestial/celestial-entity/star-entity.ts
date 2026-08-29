// 恒星の見た目: 実位置・実半径の自発光球体(遠くて球として描けないときは点像)と、
// 模式図で代わりに出す輪郭円。色と放射強度は恒星ごとの値で、シーンを照らす光源の値でもある。
import * as THREE from 'three/webgpu';
import { createStarSphere, type StarSphere } from '../../../render/star-sphere';
import { createOutlineCircle, OutlineCircle } from '../../../render/outline-circle';
import { StarMotion } from '../../../physics/celestial-motion';
import { CameraSystem } from '../../camera/camera-system';
import { FloatingOrigin } from '../../camera/floating-origin';
import { CelestialEntity } from './celestial-entity';
import type { Albedo } from '../../../render/celestial-albedo';
import type { GraphicsSettingsData } from '../../../render/graphics-settings';
import type { RenderStyle } from '../../../render/render-style';

export class StarEntity extends CelestialEntity {
  private readonly star: StarSphere;
  // 模式図で恒星の代わりに出す、実位置・実半径の輪郭円。球のシルエットなので毎フレーム
  // カメラへ正対させる。
  private readonly outline: OutlineCircle = createOutlineCircle();
  // 広範囲視点での実球体半径 [m]。
  private readonly radius: number;

  // color は恒星面と恒星光の色、radiantIntensity は距離の二乗で割ると放射照度になる量。
  constructor(
    motion: StarMotion,
    name: string,
    readonly color: THREE.Color,
    readonly radiantIntensity: number,
    surfaceColor: string | number,
  ) {
    super(motion, name, 'star', null);
    this.radius = motion.def.radius;
    this.star = createStarSphere(surfaceColor, surfaceRadianceOf(radiantIntensity, this.radius));
  }

  // 自発光なので反射の測光を持たない。
  get lightSourceAlbedo(): Albedo | null { return null; }

  get surfaceTextureUrl(): string | null { return null; }

  // 実球体・点像・輪郭円をシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    this.star.addTo(scene);
    scene.add(this.outline.line);
  }

  // 恒星の見た目と輪郭円をまとめて表示/非表示にする。
  setVisible(visible: boolean): void {
    this.star.setVisible(visible);
    this.outline.line.visible = visible;
  }

  // displayTime 時点の実位置へ恒星を置く。
  sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, _star: StarEntity | null,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void {
    if (!this.star.visible && !this.outline.line.visible) return;
    const pos = this.motion.stateAt(displayTime).r;
    const p = fo.RtoThreeV3(pos);
    if (style === 'schematic') {
      this.star.hide();
      // 円は姿勢を持たないので、球のシルエットとして見せるには毎フレームカメラへ正対させる。
      this.outline.line.visible = true;
      this.outline.line.position.copy(p);
      this.outline.line.scale.setScalar(this.radius);
      this.outline.line.quaternion.copy(cameraSystem.activeCamera.quaternion);
      return;
    }
    this.outline.line.visible = false;
    // マップビューでは実球体だけを使う。**点像を置く星殻がカメラの近平面より手前にあるとは
    // 限らない** — 引いたマップビューでは近平面が星殻より遠く、置いても写らない。
    if (cameraSystem.overviewMode) {
      this.star.syncSphere(p, this.radius);
      return;
    }
    this.star.sync(
      p, this.radius,
      this.lodApparentDiameterPx(2 * this.radius, cameraSystem.activeCameraScale(pos), graphics),
      cameraSystem.activeCamera.quaternion,
    );
  }

  // 恒星の見た目と輪郭円を親から外し、解放する。
  dispose(): void {
    this.outline.line.removeFromParent();
    this.star.dispose();
    this.outline.dispose();
  }
}

// 放射強度 I の恒星の、半径 radius の面の輝度。距離 d での放射照度 I/d² は恒星円盤が張る
// 立体角 π(radius/d)² を通して届くので、面の輝度は I/(π·radius²) になる。
function surfaceRadianceOf(radiantIntensity: number, radius: number): number {
  return radiantIntensity / (Math.PI * radius * radius);
}
