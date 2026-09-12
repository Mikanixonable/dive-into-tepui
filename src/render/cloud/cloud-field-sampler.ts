// 雲場テクスチャを、天体固定の単位方向から読む。焼いた側と同じ cap の置き方を写し取り、同じ uv
// で読む。差し込まれたテクスチャは借り物で、解放は差し込んだ側が行う。
import * as THREE from 'three/webgpu';
import { dot, step, texture, uniform } from 'three/tsl';
import { EMPTY_CLOUD_FIELD } from './cumulus-shape';
import { orthographicCapUv, type CapPlacement } from './field-projection';
import { cloudSampleFromTexel, type CloudSample } from './cloud-field-sample';
import type { FloatUniform, Vec3Node, Vec3Uniform, Vec4Node } from '../tsl-types';

// 焼いた雲場と、それを焼いた cap の置き方の組。場を出す側が毎フレーム公開し、読み手が写し取る。
export interface CloudFieldBinding {
  readonly texture: THREE.Texture;
  readonly cap: CapPlacement;
}

export class CloudFieldSampler {
  // 読む雲場のテクスチャノード。場が結ばれるまでは EMPTY_CLOUD_FIELD を読み、bind は同じノードの
  // 値を差し替える。
  private readonly field = texture(EMPTY_CLOUD_FIELD);
  // 焼いた側の cap の置き方。グラフは一度組めば済み、値だけが毎フレーム入れ替わる。
  private readonly center: Vec3Uniform = uniform(new THREE.Vector3(0, 0, 1));
  private readonly east: Vec3Uniform = uniform(new THREE.Vector3(1, 0, 0));
  private readonly north: Vec3Uniform = uniform(new THREE.Vector3(0, 1, 0));
  private readonly sinRadius: FloatUniform = uniform(1);
  private readonly cosRadius: FloatUniform = uniform(-1);

  // 焼いた場と、それを焼いた cap の置き方を写し取る。テクスチャの所有権は移らない。
  public bind(binding: CloudFieldBinding): void {
    this.field.value = binding.texture;
    this.center.value.copy(binding.cap.center);
    this.east.value.copy(binding.cap.east);
    this.north.value.copy(binding.cap.north);
    this.sinRadius.value = binding.cap.sinRadius;
    this.cosRadius.value = binding.cap.cosRadius;
  }

  // 単位方向 direction の雲標本を、生成時と同じ単位で読む。**cap の外は「雲なし」を返す** —
  // 返さないと縁の値が外へ伸び、裏側の半球では表側の雲を鏡映しに読む。
  public sampleCloud(direction: Vec3Node): CloudSample {
    const inside = step(this.cosRadius, dot(direction, this.center));
    const uv = orthographicCapUv(direction, this.east, this.north, this.sinRadius);
    return cloudSampleFromTexel(this.field.sample(uv).mul(inside) as Vec4Node);
  }
}
