// 天体固定の雲場を、描画で使う視点中心の cap へ写す派生場。正本の再生成と視点の置き直しを分離し、
// カメラ移動では世界場を変えずに view texture だけを更新する。
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { CloudFieldSource } from './cloud-field-source';
import type { CloudStateBinding } from './cloud-state';

export class CloudViewField implements CloudFieldSource {
  private readonly field: BakedField;
  private bakedWorldGeneration = -1;
  private bakedProjectionRevision = -1;
  private generationValue = 0;

  public constructor(
    private readonly world: CloudFieldSource, public readonly projection: FieldProjection,
  ) {
    const worldTexture = texture(world.texture);
    this.field = new BakedField(
      'cloudView', THREE.RGBAFormat, projection,
      (direction) => worldTexture.sample(world.projection.uvAt(direction)),
      GPU_PASS.cloudBake,
    );
  }

  public get texture(): THREE.Texture { return this.field.texture; }
  public get generation(): number { return this.generationValue; }
  public get state(): CloudStateBinding { return this.world.state; }

  // 世界場を先に準備し、その世代または view projection が変わったときだけ cap へ写す。
  public prepare(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink | null): void {
    this.world.prepare(renderer, displayTime, gpu);
    const worldGeneration = this.world.generation;
    const projectionRevision = this.projection.revision;
    if (worldGeneration === this.bakedWorldGeneration
      && projectionRevision === this.bakedProjectionRevision) return;
    this.field.render(renderer, gpu ?? undefined);
    this.generationValue += 1;
    this.bakedWorldGeneration = worldGeneration;
    this.bakedProjectionRevision = projectionRevision;
  }

  public dispose(): void {
    this.field.dispose();
    this.world.dispose();
  }
}
