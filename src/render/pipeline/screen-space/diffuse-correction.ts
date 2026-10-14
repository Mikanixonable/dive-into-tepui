// 近傍の遮蔽と照り返しを、受け手へ届く符号付き拡散照度の差分として渡す。
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import { levelTextureFormats, type BandLayout } from './band-pyramid';
import type { ShadingSample } from '../lighting/shading-sample';
import type { Vec2Node, Vec3Node } from '../../tsl-types';

// 受けた照り返しから、遮られた通常照度を引く。負値もそのまま描画先へ渡す。
export function signedDiffuseCorrection(received: Vec3Node, blocked: Vec3Node): Vec3Node {
  return received.sub(blocked);
}

// 描画命令が要求する形式の MRT 描画先。テクスチャ名は name に番号を付けたもの(1 枚なら name)で、MRT の出力と結び付く。
function createTarget(formats: ReturnType<typeof levelTextureFormats>, name: string): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    count: formats.length, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  for (const [index, texture] of target.textures.entries()) {
    texture.name = formats.length === 1 ? name : `${name}_${index}`;
    texture.type = formats[index]!.type;
    texture.format = formats[index]!.format;
  }
  return target;
}

// 寸法が width × height でなければ、target を確保し直す。
function fitSize(target: THREE.RenderTarget, width: number, height: number): void {
  if (target.width !== width || target.height !== height) target.setSize(width, height);
}

interface BandChainTargets {
  // bands[level] は段 level の帯 level..layout.length − 1 を書く出力先。段 0 は走査の出力。
  readonly bands: readonly THREE.RenderTarget[];
  // merged[level] は段 level(0..layout.length − 2)の C_level と、最も粗い段まで均された割合 A_level。
  readonly merged: readonly THREE.RenderTarget[];
}

// 符号付きの拡散照度補正 ΔE_screen の描画先 — 走査の解像度から段ごとに縮めた、遮りの画面距離の帯ごとの値と拡大と合流の
// 出力(layout ごとに 1 揃い)と、描画バッファの解像度へ復元した値(rgb = ΔE_screen)。
export class DiffuseCorrection {
  // layout ごとの段の描画先。初めて引いたときに作る。
  private readonly chains = new Map<string, BandChainTargets>();
  // 描画バッファの解像度の、復元した補正。
  public readonly target = createTarget(
    [{ type: THREE.HalfFloatType, format: THREE.RGBAFormat }], 'diffuseCorrection');

  public get texture(): THREE.Texture { return this.target.texture; }

  // 段 level(0..layout.length − 1)の描画先。段 0 は走査の出力。
  public bandTarget(layout: BandLayout, level: number): THREE.RenderTarget {
    return this.chainOf(layout).bands[level]!;
  }

  // 段 level の描画先テクスチャを描画命令順に並べる。
  public bandTextures(layout: BandLayout, level: number): readonly THREE.Texture[] {
    return this.bandTarget(layout, level).textures;
  }

  // 段 level(0..layout.length − 2)の拡大と合流の出力 C_level の描画先。
  public mergedTarget(layout: BandLayout, level: number): THREE.RenderTarget {
    return this.chainOf(layout).merged[level]!;
  }

  // C_level(rgb)と最も粗い段まで均された割合 A_level(α)を持つテクスチャ。最も粗い段では、その段の帯のテクスチャを返す。
  // 段 0 が、走査の解像度の、最後の拡大の前の補正。
  public mergedTexture(layout: BandLayout, level: number): THREE.Texture {
    return level === layout.length - 1
      ? this.bandTarget(layout, level).texture
      : this.mergedTarget(layout, level).texture;
  }

  // 確保した全描画先。
  public get targets(): readonly THREE.RenderTarget[] {
    return [...[...this.chains.values()].flatMap(({ bands, merged }) => [...bands, ...merged]), this.target];
  }

  // layout の各段の描画先を levelSizes(levelSizes[level] が段 level の幅と高さ [段の画素]。段 0 は走査の寸法)へ、
  // 復元した補正の描画先を描画バッファの寸法 width × height へ合わせる。寸法が変わった描画先だけを確保し直す。
  public setSize(
    layout: BandLayout, levelSizes: readonly (readonly [number, number])[], width: number, height: number,
  ): void {
    const { bands, merged } = this.chainOf(layout);
    for (const [level, target] of bands.entries()) {
      const [levelWidth, levelHeight] = levelSizes[level]!;
      fitSize(target, levelWidth, levelHeight);
    }
    for (const [level, target] of merged.entries()) {
      const [levelWidth, levelHeight] = levelSizes[level]!;
      fitSize(target, levelWidth, levelHeight);
    }
    fitSize(this.target, width, height);
  }

  // sample の画素の、復元した補正。
  public at(sample: ShadingSample): Vec3Node { return this.atUv(sample.uv); }

  // uv(0..1)の位置の、復元した補正。
  public atUv(uv: Vec2Node): Vec3Node { return texture(this.texture, uv).rgb; }

  // 作った描画先をすべて解放する。
  public dispose(): void {
    for (const target of this.targets) target.dispose();
  }

  // layout の描画先一式。layout ごとに共有する。
  private chainOf(layout: BandLayout): BandChainTargets {
    const key = JSON.stringify(layout);
    const existing = this.chains.get(key);
    if (existing !== undefined) return existing;
    const chain: BandChainTargets = {
      bands: layout.map((format, level) =>
        createTarget(levelTextureFormats(layout.length, level, format), `diffuseCorrectionBands${level}_${format}`)),
      merged: Array.from({ length: layout.length - 1 }, (_, level) => createTarget(
        [{ type: THREE.HalfFloatType, format: THREE.RGBAFormat }], `mergedDiffuseCorrection${level}`)),
    };
    this.chains.set(key, chain);
    return chain;
  }
}
