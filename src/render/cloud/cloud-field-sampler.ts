// 雲場テクスチャを天体固定の方向から読む共有入力。テクスチャの所有者は GeneratedCloudField であり、
// この型は読み取り用の TSL ノードと UV/mip の規則だけを持つ。表現 renderer は同じ sampler を参照し、
// それぞれが sphereMeshUv や fieldLodForWidth を再実装しない。
import * as THREE from 'three/webgpu';
import { float, fract, int, log2, max, texture, vec2 } from 'three/tsl';
import { sphereMeshUv } from '../celestial-surface';
import { EMPTY_CLOUD_FIELD } from './cumulus-shape';
import type { FloatNode, Vec3Node, Vec4Node } from '../tsl-types';

export class CloudFieldSampler {
  // EMPTY_CLOUD_FIELD は場を持たない renderer がグラフを組むための初期値であり、sampler は
  // texture ノードの差し替えだけを行う。RenderTarget の dispose は GeneratedCloudField が行う。
  private readonly field = texture(EMPTY_CLOUD_FIELD);

  // 場の幅は生成側の projection の変更を受けるため、テクスチャから読む共有ノードにする。
  private readonly fieldWidth = (this.field.size(int(0)) as THREE.Node<'uvec2'>).x;

  public constructor(field?: THREE.Texture) {
    if (field !== undefined) this.field.value = field;
  }

  public get texture(): THREE.Texture { return this.field.value as THREE.Texture; }

  // 表現 renderer が現在の生成場へ同期する。sampler は texture の所有権を持たない。
  public setTexture(field: THREE.Texture): void { this.field.value = field; }

  // 天体固定の単位方向を、雲場の球メッシュ UV へ変換して読む。経度の wrap を明示し、mip が
  // 画面微分へ依存しない読み手では lod を指定する。
  public sample(direction: Vec3Node, lod?: FloatNode): Vec4Node {
    const uv = sphereMeshUv(direction);
    const sample = this.field.sample(vec2(fract(uv.x), uv.y));
    return lod === undefined ? sample : sample.level(lod);
  }

  // 光路や殻の交点のように画面の隣接画素と連続しない標本の mip を共通選択する。
  public lodForWidth(width: FloatNode, radius: FloatNode): FloatNode {
    const texelWidth = radius.mul(2 * Math.PI).div(float(this.fieldWidth));
    return max(log2(width.div(max(texelWidth, 1))), float(0));
  }
}
