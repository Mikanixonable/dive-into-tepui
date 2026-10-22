// 近傍の遮蔽と照り返しを、受け手へ届く符号付き拡散照度の差分として渡す。
import * as THREE from 'three/webgpu';
import { floor, ivec2, screenSize, texture } from 'three/tsl';
import { levelTextureFormats, type BandLayout } from './band-pyramid';
import type { ShadingSample } from '../lighting/shading-sample';
import type { Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';

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
  // 蓄積後の補正・深度・法線。前フレームと今のフレームを交互に書く。
  private readonly temporalTargets = [
    createTarget([
      { type: THREE.HalfFloatType, format: THREE.RGBAFormat },
      { type: THREE.FloatType, format: THREE.RedFormat },
      { type: THREE.HalfFloatType, format: THREE.RGFormat },
    ], 'diffuseCorrection0'),
    createTarget([
      { type: THREE.HalfFloatType, format: THREE.RGBAFormat },
      { type: THREE.FloatType, format: THREE.RedFormat },
      { type: THREE.HalfFloatType, format: THREE.RGFormat },
    ], 'diffuseCorrection1'),
  ] as const;
  private targetIndex: 0 | 1 = 0;
  private readonly targetSampler = texture(this.temporalTargets[0].texture);
  // 描画バッファの解像度の、蓄積する前の補正 (rgb = ΔE_screen)。
  public readonly upsampledTarget = createTarget(
    [{ type: THREE.HalfFloatType, format: THREE.RGBAFormat }], 'upsampledDiffuseCorrection');

  public constructor() {
    // 補正履歴だけを双線形で読めるようにする。深度と法線は面の判定なので最寄りのまま。
    for (const target of this.temporalTargets) {
      target.textures[0]!.minFilter = THREE.LinearFilter;
      target.textures[0]!.magFilter = THREE.LinearFilter;
    }
  }

  public get target(): THREE.RenderTarget { return this.temporalTargets[this.targetIndex]; }
  public get texture(): THREE.Texture { return this.target.texture; }

  // index の蓄積先を返す。
  public targetAt(index: 0 | 1): THREE.RenderTarget { return this.temporalTargets[index]; }

  // 蓄積出力と描画後に読む補正の組を index へ切り替える。
  public setTargetIndex(index: 0 | 1): void {
    this.targetIndex = index;
    this.targetSampler.value = this.target.texture;
  }

  // 現在の蓄積出力を UV から読む。
  public valueAtUv(uv: Vec2Node): Vec4Node {
    return this.targetSampler.load(ivec2(floor(uv.mul(screenSize)))) as Vec4Node;
  }

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

  // 作った描画先すべて — layout ごとの段ごとの描画先、蓄積前の補正、蓄積後の補正。
  public get targets(): readonly THREE.RenderTarget[] {
    return [...[...this.chains.values()].flatMap(({ bands, merged }) => [...bands, ...merged]),
      this.upsampledTarget, ...this.temporalTargets];
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
    fitSize(this.upsampledTarget, width, height);
    for (const target of this.temporalTargets) fitSize(target, width, height);
  }

  // sample の画素の、復元した補正。
  public at(sample: ShadingSample): Vec3Node { return this.atUv(sample.uv); }

  // uv(0..1)の位置の、復元した補正。
  public atUv(uv: Vec2Node): Vec3Node { return this.valueAtUv(uv).rgb; }

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
