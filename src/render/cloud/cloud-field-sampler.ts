// 雲場テクスチャを、天体固定の単位方向から読む。読み取りの TSL ノードと UV の引き方を持つ。
// 差し込まれたテクスチャは借り物で、解放は差し込んだ側が行う。
import * as THREE from 'three/webgpu';
import { fract, texture, vec2 } from 'three/tsl';
import { sphereMeshUv } from '../celestial/celestial-surface';
import { EMPTY_CLOUD_FIELD } from './cumulus-shape';
import { cloudSampleFromTexel, type CloudSample } from './cloud-field-sample';
import type { Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

// 天体固定の単位方向を雲場の UV へ写す関数。
export type CloudUvAt = (direction: Vec3Node) => Vec2Node;

export class CloudFieldSampler {
  // 読む雲場のテクスチャノード。場が差し込まれるまでは EMPTY_CLOUD_FIELD を読み、setTexture は
  // 同じノードの値を差し替える。
  private readonly field = texture(EMPTY_CLOUD_FIELD);

  // field を渡せば、はじめからその場を読む。uvAt は方向から雲場 UV への写しで、既定は球メッシュの uv。
  public constructor(
    field?: THREE.Texture,
    private readonly uvAt: CloudUvAt = sphereMeshUv,
  ) {
    if (field !== undefined) this.setTexture(field);
  }

  public get texture(): THREE.Texture { return this.field.value as THREE.Texture; }

  // 読む雲場を差し替える。テクスチャの所有権は移らない。
  public setTexture(field: THREE.Texture): void {
    this.field.value = field;
  }

  // 単位方向 direction の雲場の texel。
  private sample(direction: Vec3Node): Vec4Node {
    // uv の経度は 0..1 の外へ出うるので、周回させて読む。
    const uv = this.uvAt(direction);
    return this.field.sample(vec2(fract(uv.x), uv.y));
  }

  // 単位方向 direction の雲標本を、生成時と同じ単位で読む。
  public sampleCloud(direction: Vec3Node): CloudSample {
    return cloudSampleFromTexel(this.sample(direction));
  }
}
