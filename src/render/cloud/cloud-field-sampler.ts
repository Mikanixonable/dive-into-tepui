// 雲場テクスチャを、天体固定の単位方向から読む。読み取りの TSL ノードと、UV・mip 段の選び方を
// 持つ。差し込まれたテクスチャは借り物で、解放は差し込んだ側が行う。
import * as THREE from 'three/webgpu';
import { float, fract, greaterThan, int, log2, max, min, select, texture, uniform, vec2 } from 'three/tsl';
import { sphereMeshUv } from '../celestial/celestial-surface';
import { EMPTY_CLOUD_FIELD } from './cumulus-shape';
import { maxAvailableMipLevelOf } from './baked-field';
import { cloudSampleFromTexel, type CloudSample } from './cloud-field-sample';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

// 天体固定の単位方向を雲場の UV へ写す関数。
export type CloudUvAt = (direction: Vec3Node) => Vec2Node;
// mip 段の選び方。'explicit' は読み手の指定(指定が無ければ画面微分)、'fixed' は全読みを固定段で
// 読む診断用。
export type CloudLodMode = 'explicit' | 'fixed';

export class CloudFieldSampler {
  // 読む雲場のテクスチャノード。場が差し込まれるまでは EMPTY_CLOUD_FIELD を読み、setTexture は
  // 同じノードの値を差し替える。
  private readonly field = texture(EMPTY_CLOUD_FIELD);

  // 場の幅 [texel]。差し込むテクスチャで変わるので、テクスチャから読むノードにする。
  private readonly fieldWidth = (this.field.size(int(0)) as THREE.Node<'uvec2'>).x;
  // 読める最大の mip 段。texture.mipmaps.length は GPU が自動生成した段を数えないので、テクスチャの
  // 設定と寸法から求める — 生成されていない段を明示 LOD で読まないため。
  private readonly maxMipLevel = uniform(0);
  // 1 なら全読みを fixedLod の段で読む(診断用)。0 なら読み手の指定に従う。
  private readonly fixedLodMode = uniform(0);
  private readonly fixedLod = uniform(0);

  // field を渡せば、はじめからその場を読む。uvAt は方向から雲場 UV への写しで、既定は球メッシュの uv。
  public constructor(
    field?: THREE.Texture,
    private readonly uvAt: CloudUvAt = sphereMeshUv,
  ) {
    if (field !== undefined) this.setTexture(field);
  }

  public get texture(): THREE.Texture { return this.field.value as THREE.Texture; }

  // 読む雲場を差し替え、読める最大の mip 段を引き直す。テクスチャの所有権は移らない。
  public setTexture(field: THREE.Texture): void {
    this.field.value = field;
    const image = field.image as { readonly width?: number; readonly height?: number } | undefined;
    this.maxMipLevel.value = maxAvailableMipLevelOf(
      image?.width ?? 1, image?.height ?? 1, field.generateMipmaps, field.mipmaps.length,
    );
  }

  // mip 段の選び方を切り替える(診断用)。fixedLevel は 'fixed' のときに読む段で、実在する段へ
  // 切り詰めて読む。
  public setLodSampling(mode: CloudLodMode, fixedLevel = 0): void {
    this.fixedLodMode.value = mode === 'fixed' ? 1 : 0;
    this.fixedLod.value = fixedLevel;
  }

  // 単位方向 direction の雲場の texel。lod を渡せばその mip 段で読み、渡さなければ画面微分で
  // 段を選ぶ。
  private sample(direction: Vec3Node, lod?: FloatNode): Vec4Node {
    // uv の経度は 0..1 の外へ出うるので、周回させて読む。
    const uv = this.uvAt(direction);
    const sample = this.field.sample(vec2(fract(uv.x), uv.y));
    // 読み手の指定した段は、実在する段へ切り詰める。
    const selected = lod === undefined
      ? sample
      : sample.level(min(max(lod, 0), this.maxMipLevel));
    // 診断の固定段が立っていれば、読み手の指定より優先する。
    return select(
      greaterThan(this.fixedLodMode, 0.5),
      sample.level(min(max(this.fixedLod, 0), this.maxMipLevel)),
      selected,
    );
  }

  // 単位方向 direction の雲標本を、生成時と同じ単位で読む。lod を渡せばその mip 段で読む。
  public sampleCloud(direction: Vec3Node, lod?: FloatNode): CloudSample {
    return cloudSampleFromTexel(this.sample(direction, lod));
  }

  // 幅 width [m] を 1 texel で覆う mip 段。半径 radius [m] の球面で測る。画面の隣接画素と連続しない
  // 標本(光路上など)の lod に渡す。
  public lodForWidth(width: FloatNode, radius: FloatNode): FloatNode {
    const texelWidth = this.fieldTexelWidth(radius);
    return min(max(log2(width.div(max(texelWidth, 1))), float(0)), this.maxMipLevel);
  }

  // この半径の球面上で、fieldの経度1 texelが張る物理幅 [m]。
  public fieldTexelWidth(radius: FloatNode): FloatNode {
    return radius.mul(2 * Math.PI).div(float(this.fieldWidth));
  }
}
