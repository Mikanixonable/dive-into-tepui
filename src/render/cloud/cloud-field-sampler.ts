// 雲場テクスチャを、天体固定の単位方向から正距円筒図法で読む。差し込まれたテクスチャは借り物で、
// 解放は差し込んだ側が行う。
import type * as THREE from 'three/webgpu';
import { fract, texture, vec2 } from 'three/tsl';
import { EMPTY_CLOUD_FIELD } from './cumulus-shape';
import { equirectUvFromDirection } from './field-projection';
import { cloudSampleFromTexel, type CloudSample } from './cloud-field-sample';
import type { CloudStateBinding } from './cloud-state';
import type { Vec3Node, Vec4Node } from '../tsl-types';

// 焼いた雲場と、その時刻。場を出す側が公開し、読み手が写し取る。
export interface CloudFieldBinding {
  readonly texture: THREE.Texture;
  readonly state: CloudStateBinding;
}

export class CloudFieldSampler {
  // 読む雲場のテクスチャノード。場が結ばれるまでは EMPTY_CLOUD_FIELD を読み、bind は同じノードの
  // 値を差し替える。
  private readonly field = texture(EMPTY_CLOUD_FIELD);
  private state: CloudStateBinding = {
    absoluteTimeSeconds: 0,
    seed: 0,
  };

  // 焼いた場と時刻を写し取る。テクスチャの所有権は移らない。
  public bind(binding: CloudFieldBinding): void {
    this.field.value = binding.texture;
    this.state = binding.state;
  }

  public get stateBinding(): CloudStateBinding { return this.state; }

  // 単位方向 direction の雲標本を、生成時と同じ正距円筒の uv で読む。経度の巻き目は繰り返し、
  // 緯度は端へ留める。
  public sampleCloud(direction: Vec3Node): CloudSample {
    const uv = equirectUvFromDirection(direction);
    return cloudSampleFromTexel(this.field.sample(vec2(fract(uv.x), uv.y)) as Vec4Node);
  }
}
