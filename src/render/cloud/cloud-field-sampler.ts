// 雲場テクスチャを天体固定の方向から読む共有入力。テクスチャの所有者は GeneratedCloudField であり、
// この型は読み取り用の TSL ノードと UV/mip の規則だけを持つ。表現 renderer は同じ sampler を参照し、
// それぞれが sphereMeshUv や fieldLodForWidth を再実装しない。
import * as THREE from 'three/webgpu';
import { float, fract, greaterThan, If, int, log2, max, min, texture, uniform, vec2 } from 'three/tsl';
import { sphereMeshUv } from '../celestial-surface';
import { EMPTY_CLOUD_FIELD } from './cumulus-shape';
import { maxAvailableMipLevelOf } from './baked-field';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

export type CloudUvAt = (direction: Vec3Node) => Vec2Node;
export type CloudLodMode = 'explicit' | 'fixed';

export class CloudFieldSampler {
  // EMPTY_CLOUD_FIELD は場を持たない renderer がグラフを組むための初期値であり、sampler は
  // texture ノードの差し替えだけを行う。RenderTarget の dispose は GeneratedCloudField が行う。
  private readonly field = texture(EMPTY_CLOUD_FIELD);

  // 場の幅は生成側の projection の変更を受けるため、テクスチャから読む共有ノードにする。
  private readonly fieldWidth = (this.field.size(int(0)) as THREE.Node<'uvec2'>).x;
  // texture.mipmaps.lengthではGPU自動生成分を読めない。テクスチャ設定と寸法から契約上の最大
  // LODをuniformへ置き、未生成テクスチャへ明示LODを発行しない。
  private readonly maxMipLevel = uniform(0);
  // 診断時だけ固定LODへ切り替える。0 は現行の明示/暗黙の選択、1 は fixedLod を全読みに適用する。
  private readonly fixedLodMode = uniform(0);
  private readonly fixedLod = uniform(0);

  public constructor(
    field?: THREE.Texture,
    private readonly uvAt: CloudUvAt = sphereMeshUv,
  ) {
    if (field !== undefined) this.setTexture(field);
  }

  public get texture(): THREE.Texture { return this.field.value as THREE.Texture; }

  // 表現 renderer が現在の生成場へ同期する。sampler は texture の所有権を持たない。
  public setTexture(field: THREE.Texture): void {
    this.field.value = field;
    const image = field.image as { readonly width?: number; readonly height?: number } | undefined;
    this.maxMipLevel.value = maxAvailableMipLevelOf(
      image?.width ?? 1, image?.height ?? 1, field.generateMipmaps, field.mipmaps.length,
    );
  }

  // 雲場の比較用LOD規則を置き直す。固定LODも実在するミップ段へクランプされるので、
  // 診断設定から未生成ミップを読むことはない。
  public setLodSampling(mode: CloudLodMode, fixedLevel = 0): void {
    this.fixedLodMode.value = mode === 'fixed' ? 1 : 0;
    this.fixedLod.value = fixedLevel;
  }

  // 天体固定の単位方向を、生成側から注入された雲場 UV へ変換して読む。経度の wrap を明示し、
  // mip が画面微分へ依存しない読み手では lod を指定する。
  public sample(direction: Vec3Node, lod?: FloatNode): Vec4Node {
    const uv = this.uvAt(direction);
    const sample = this.field.sample(vec2(fract(uv.x), uv.y));
    const selected = lod === undefined
      ? sample
      : sample.level(min(max(lod, 0), this.maxMipLevel));
    const value = selected.toVar();
    If(greaterThan(this.fixedLodMode, 0.5), () => {
      value.assign(sample.level(min(max(this.fixedLod, 0), this.maxMipLevel)));
    });
    return value;
  }

  // 光路や殻の交点のように画面の隣接画素と連続しない標本の mip を共通選択する。
  public lodForWidth(width: FloatNode, radius: FloatNode): FloatNode {
    const texelWidth = this.fieldTexelWidth(radius);
    return min(max(log2(width.div(max(texelWidth, 1))), float(0)), this.maxMipLevel);
  }

  // この半径の球面上で、fieldの経度1 texelが張る物理幅 [m]。
  public fieldTexelWidth(radius: FloatNode): FloatNode {
    return radius.mul(2 * Math.PI).div(float(this.fieldWidth));
  }
}
