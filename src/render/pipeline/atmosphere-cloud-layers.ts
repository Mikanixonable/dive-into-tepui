// 大気ray marchへ連続雲体積を接続する配線。雲のfield解釈と高度profileはCloudVolumeへ委譲し、
// ここは大気積分器から受けた真球空間の位置・光線・局所太陽入力を渡すだけにする。
import {
  CloudAtmosphereRenderer, type CloudSpecies, type CloudVolumeMedium,
} from './cloud-atmosphere-renderer';
import type { CloudLodMode } from '../cloud/cloud-field-sampler';
import type { BoolNode, FloatNode, Vec3Node } from '../tsl-types';

export class AtmosphereCloudLayers {
  private readonly clouds = new CloudAtmosphereRenderer();

  public setClouds(clouds: Parameters<CloudAtmosphereRenderer['set']>[0]): void {
    this.clouds.set(clouds);
  }

  public setSpeciesEnabled(species: CloudSpecies, enabled: boolean): void {
    this.clouds.setSpeciesEnabled(species, enabled);
  }

  public setLodSampling(mode: CloudLodMode, fixedLevel = 0): void {
    this.clouds.setLodSampling(mode, fixedLevel);
  }

  public hasVolume(): BoolNode { return this.clouds.hasVolume(); }

  public mediumAt(
    offset: Vec3Node, rayDir: Vec3Node, sunDir: Vec3Node, sunRadiance: Vec3Node,
    groundRadius: FloatNode, footprint: FloatNode,
  ): CloudVolumeMedium {
    return this.clouds.mediumAt(
      offset, rayDir, sunDir, sunRadiance, groundRadius, footprint,
    );
  }
}
