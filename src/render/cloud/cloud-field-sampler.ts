// 雲場テクスチャを、天体固定の単位方向から cap の置き方に合わせて読む。差し込まれたテクスチャは
// 借り物で、解放は差し込んだ側が行う。
import * as THREE from 'three/webgpu';
import { dot, step, texture, uniform } from 'three/tsl';
import { EMPTY_CLOUD_FIELD } from './cumulus-shape';
import { orthographicCapUv, type CapPlacement } from '../field-projection';
import { cloudSampleFromTexels, type CloudSample } from './cloud-field-sample';
import type { CloudStateBinding } from './cloud-state';
import type { FloatUniform, Vec3Node, Vec3Uniform, Vec4Node } from '../tsl-types';

// 焼いた雲場の basis / shape と、その cap の置き方・時刻。場を出す側が公開し、読み手が写し取る。
export interface CloudFieldBinding {
  readonly basisTexture: THREE.Texture;
  readonly shapeTexture: THREE.Texture;
  readonly cap: CapPlacement;
  readonly state: CloudStateBinding;
}

export class CloudFieldSampler {
  // 読む雲場のテクスチャノード。場が結ばれるまでは EMPTY_CLOUD_FIELD を読み、bind は同じノードの値を差し替える。
  private readonly basisField = texture(EMPTY_CLOUD_FIELD);
  private readonly shapeField = texture(EMPTY_CLOUD_FIELD);
  // 焼いた側の cap の置き方。グラフは一度組めば済み、値だけが毎フレーム入れ替わる。
  private readonly center: Vec3Uniform = uniform(new THREE.Vector3(0, 0, 1));
  private readonly east: Vec3Uniform = uniform(new THREE.Vector3(1, 0, 0));
  private readonly north: Vec3Uniform = uniform(new THREE.Vector3(0, 1, 0));
  private readonly sinRadius: FloatUniform = uniform(1);
  private readonly cosRadius: FloatUniform = uniform(-1);
  private state: CloudStateBinding = {
    absoluteTimeSeconds: 0,
    seed: 0,
  };

  // 焼いた場と、その cap の置き方・時刻を写し取る。テクスチャの所有権は移らない。
  public bind(binding: CloudFieldBinding): void {
    this.basisField.value = binding.basisTexture;
    this.shapeField.value = binding.shapeTexture;
    this.center.value.copy(binding.cap.center);
    this.east.value.copy(binding.cap.east);
    this.north.value.copy(binding.cap.north);
    this.sinRadius.value = binding.cap.sinRadius;
    this.cosRadius.value = binding.cap.cosRadius;
    this.state = binding.state;
  }

  public get stateBinding(): CloudStateBinding { return this.state; }

  // 単位方向 direction の雲標本を、生成時と同じ cap の uv で読む。cap の外は雲なしとする。
  public sampleCloud(direction: Vec3Node): CloudSample {
    const inside = step(this.cosRadius, dot(direction, this.center));
    const uv = orthographicCapUv(direction, this.east, this.north, this.sinRadius);
    return cloudSampleFromTexels(
      this.basisField.sample(uv).mul(inside) as Vec4Node,
      this.shapeField.sample(uv).mul(inside) as Vec4Node,
    );
  }
}
