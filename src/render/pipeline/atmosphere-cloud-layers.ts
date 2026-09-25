// 大気積分器と雲の共有3D密度評価器の境界。旧実装の固定球殻イベントは持たず、
// 大気レイマーチの各標本点をそのまま雲媒質へ写す。
import { CloudAtmosphereRenderer, type CloudSpecies, type CloudVolumeSample } from './cloud-atmosphere-renderer';
import type { AtmosphereClouds } from '../atmosphere';
import type { FloatNode, Vec3Node } from '../tsl-types';

export class AtmosphereCloudLayers {
  private readonly clouds = new CloudAtmosphereRenderer();

  public setClouds(clouds: AtmosphereClouds | null): void {
    this.clouds.set(clouds);
  }

  public setShellEnabled(species: CloudSpecies, enabled: boolean): void {
    this.clouds.setShellEnabled(species, enabled);
  }

  public mediumAt(
    sphereDirection: Vec3Node,
    altitudeM: FloatNode,
    footprintM: FloatNode,
    sunDirection: Vec3Node,
    sunRadiance: Vec3Node,
  ): CloudVolumeSample {
    return this.clouds.sampleAt(
      sphereDirection, altitudeM, footprintM, sunDirection, sunRadiance,
    );
  }
}
