// 近傍の遮蔽と照り返しを、受け手へ届く符号付き拡散照度の差分として渡す。
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import { packedTextureCount } from './band-pyramid';
import type { ShadingSample } from '../lighting/shading-sample';
import type { Vec2Node, Vec3Node } from '../../tsl-types';

// 受けた照り返しから、遮られた通常照度を引く。負値もそのまま描画先へ渡す。
export function signedDiffuseCorrection(received: Vec3Node, blocked: Vec3Node): Vec3Node {
  return received.sub(blocked);
}

// 補正の描画先。textureCount 枚の rgba で、負の遮蔽項を保つため半精度浮動小数に書く。テクスチャの名前は name に
// 番号を付けたもの(1 枚なら name)で、MRT の出力と結び付く。
function createTarget(textureCount: number, name: string): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    count: textureCount, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  for (const [index, texture] of target.textures.entries()) {
    texture.name = textureCount === 1 ? name : `${name}_${index}`;
  }
  return target;
}

// 寸法が width × height でなければ、target を確保し直す。
function fitSize(target: THREE.RenderTarget, width: number, height: number): void {
  if (target.width !== width || target.height !== height) target.setSize(width, height);
}

// 帯の数 1 つぶんの、段ごとの描画先 — bands[m] は段 m の帯 m..count − 1 を詰めたもの(段 0 が走査の出力で packedBands、
// 段 1 以降は実効画素数も持つ packedReducedBands の並び)、merged[k] は段 k(0..count − 2)の拡大と合流の出力(rgb は C_k、
// 段 1 以降の α は段 k の実効画素数)。
interface BandChainTargets {
  readonly bands: readonly THREE.RenderTarget[];
  readonly merged: readonly THREE.RenderTarget[];
}

// 符号付きの拡散照度補正 ΔE_screen の描画先 — 走査の解像度から段ごとに縮めた、遮りの画面距離の帯ごとの値と拡大と合流の
// 出力(帯の数ごとに 1 揃い)と、描画バッファの解像度へ復元した値(rgb = ΔE_screen)。
export class DiffuseCorrection {
  // 帯の数ごとの、段ごとの描画先。初めて引いたときに作る。
  private readonly chains = new Map<number, BandChainTargets>();
  // 描画バッファの解像度の、復元した補正。
  public readonly target = createTarget(1, 'diffuseCorrection');

  public get texture(): THREE.Texture { return this.target.texture; }

  // 帯の数 count の、段 level(0..count − 1)の帯 level..count − 1 を詰めた描画先。段 0 は走査の出力。
  public bandTarget(count: number, level: number): THREE.RenderTarget {
    return this.chainOf(count).bands[level]!;
  }

  // 帯の数 count の、段 level(0..count − 2)の拡大と合流の出力 C_level の描画先。
  public mergedTarget(count: number, level: number): THREE.RenderTarget {
    return this.chainOf(count).merged[level]!;
  }

  // 帯の数 count の C_level(rgb)と、段 1 以降なら段 level の実効画素数(α)を持つテクスチャ。最も粗い段 count − 1 では、
  // その段の帯(帯 count − 1 と実効画素数)の描画先。段 0 が、走査の解像度の、最後の拡大の前の補正。
  public mergedTexture(count: number, level: number): THREE.Texture {
    return level === count - 1 ? this.bandTarget(count, level).texture : this.mergedTarget(count, level).texture;
  }

  // 作った描画先すべて — 帯の数ごとの段ごとの描画先と、復元した補正の描画先。
  public get targets(): readonly THREE.RenderTarget[] {
    return [...[...this.chains.values()].flatMap(({ bands, merged }) => [...bands, ...merged]), this.target];
  }

  // 帯の数 count の段ごとの描画先を levelSizes(levelSizes[level] が段 level の幅と高さ [段の画素]。段 0 は走査の寸法)へ、
  // 復元した補正の描画先を描画バッファの寸法 width × height へ合わせる。寸法が変わった描画先だけを確保し直す。
  public setSize(
    count: number, levelSizes: readonly (readonly [number, number])[], width: number, height: number,
  ): void {
    const { bands, merged } = this.chainOf(count);
    for (const levelTargets of [bands, merged]) {
      for (const [level, target] of levelTargets.entries()) {
        const [levelWidth, levelHeight] = levelSizes[level]!;
        fitSize(target, levelWidth, levelHeight);
      }
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

  // 帯の数 count の段ごとの描画先。まだ無ければ作る。
  private chainOf(count: number): BandChainTargets {
    const existing = this.chains.get(count);
    if (existing !== undefined) return existing;
    // 段 level の帯の描画先は段 level の帯を詰める枚数を持ち、拡大と合流の出力は最も粗い段のぶんだけ少ない。
    const chain: BandChainTargets = {
      bands: Array.from({ length: count }, (_, level) =>
        createTarget(packedTextureCount(count, level), `diffuseCorrectionBands${level}`)),
      merged: Array.from({ length: count - 1 }, (_, level) =>
        createTarget(1, `mergedDiffuseCorrection${level}`)),
    };
    this.chains.set(count, chain);
    return chain;
  }
}
