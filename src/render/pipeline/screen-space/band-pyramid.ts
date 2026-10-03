// 画面距離の帯ごとに分けた補正の、描画先への詰め方。帯 b の rgb を、RGBA のテクスチャを並べた通しのチャンネル
// 3b..3b + 2 へ順に詰める。
import type * as THREE from 'three/webgpu';
import { float, textureLoad, vec3, vec4 } from 'three/tsl';
import type { Texel } from './surface-weight';
import type { FloatNode, Vec3Node, Vec4Node } from '../../tsl-types';

// RGBA のテクスチャ 1 枚のチャンネルの数。
const CHANNELS_PER_TEXTURE = 4;

// 帯の数 count の補正を詰める RGBA のテクスチャの枚数。
export function packedTextureCount(count: number): number {
  return Math.ceil((3 * count) / CHANNELS_PER_TEXTURE);
}

// 帯ごとの補正 bands を、packedTextureCount 枚の RGBA へ詰める。余りのチャンネルは 0。
export function packedBands(bands: readonly Vec3Node[]): Vec4Node[] {
  const channels: FloatNode[] = bands.flatMap((band) => [band.x, band.y, band.z]);
  const channelAt = (index: number): FloatNode => channels[index] ?? float(0);
  return Array.from({ length: packedTextureCount(bands.length) }, (_, texture) => {
    const first = texture * CHANNELS_PER_TEXTURE;
    return vec4(channelAt(first), channelAt(first + 1), channelAt(first + 2), channelAt(first + 3));
  });
}

// packedBands で詰めた値 packed から、count 個の帯ごとの補正を取り出す。
export function unpackedBands(packed: readonly Vec4Node[], count: number): Vec3Node[] {
  const channels: FloatNode[] = packed.flatMap((value) => [value.x, value.y, value.z, value.w]);
  return Array.from({ length: count }, (_, band) => {
    const [r, g, b] = channels.slice(3 * band, 3 * band + 3);
    return vec3(r!, g!, b!);
  });
}

// packedBands で詰めて描いたテクスチャ textures の画素 texel から、count 個の帯ごとの補正を読む。
export function bandsAt(textures: readonly THREE.Texture[], count: number, texel: Texel): Vec3Node[] {
  return unpackedBands(textures.map((texture) => textureLoad(texture, texel)), count);
}
