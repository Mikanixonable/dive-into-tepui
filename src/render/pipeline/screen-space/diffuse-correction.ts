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

// 補正の描画先。textureCount 枚の rgba で、負の遮蔽項を保つため半精度浮動小数に書く。
function createTarget(textureCount: number): THREE.RenderTarget {
  return new THREE.RenderTarget(1, 1, {
    count: textureCount, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
}

// 寸法が width × height でなければ、target を確保し直す。
function fitSize(target: THREE.RenderTarget, width: number, height: number): void {
  if (target.width !== width || target.height !== height) target.setSize(width, height);
}

// 符号付きの拡散照度補正 ΔE_screen の描画先 — 走査の解像度で求めた、遮りの画面距離の帯ごとの生の値を詰めたもの
// (帯の数ごとに 1 つ)と、描画バッファの解像度へ復元した値(rgb = ΔE_screen)。
export class DiffuseCorrection {
  // 帯の数ごとの、走査の解像度の復元前の補正を packedBands の並びで詰めた描画先。初めて引いたときに作る。
  private readonly bandTargets = new Map<number, THREE.RenderTarget>();
  // 描画バッファの解像度の、復元した補正。
  public readonly target = createTarget(1);

  // 復元した補正の出力に名前を付ける。
  public constructor() {
    this.target.texture.name = 'diffuseCorrection';
  }

  public get texture(): THREE.Texture { return this.target.texture; }

  // 帯の数 count の補正を詰める描画先。テクスチャの名前は MRT の出力と結び付く。帯の数ごとに同じ描画先を返す。
  public bandTarget(count: number): THREE.RenderTarget {
    const existing = this.bandTargets.get(count);
    if (existing !== undefined) return existing;
    const target = createTarget(packedTextureCount(count));
    for (const [index, texture] of target.textures.entries()) texture.name = `diffuseCorrectionBands${index}`;
    this.bandTargets.set(count, target);
    return target;
  }

  // 作った描画先すべて — 帯の数ごとの帯の描画先と、復元した補正の描画先。
  public get targets(): readonly THREE.RenderTarget[] {
    return [...this.bandTargets.values(), this.target];
  }

  // 帯の数 count の描画先を走査の解像度 scanWidth × scanHeight へ、復元した補正の描画先を描画バッファの解像度
  // width × height へ合わせる。寸法が変わった描画先だけを確保し直す。
  public setSize(count: number, scanWidth: number, scanHeight: number, width: number, height: number): void {
    fitSize(this.bandTarget(count), scanWidth, scanHeight);
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
}
