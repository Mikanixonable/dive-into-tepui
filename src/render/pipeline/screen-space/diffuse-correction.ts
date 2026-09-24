// 近傍の遮蔽と照り返しを、受け手へ届く符号付き拡散照度の差分として渡す。
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import type { ShadingSample } from '../lighting/shading-sample';
import type { Vec2Node, Vec3Node } from '../../tsl-types';

// 受けた照り返しから、遮られた通常照度を引く。負値もそのまま描画先へ渡す。
export function signedDiffuseCorrection(received: Vec3Node, blocked: Vec3Node): Vec3Node {
  return received.sub(blocked);
}

export class DiffuseCorrection {
  // rgb = ΔE_screen。負の遮蔽項を保つため半精度浮動小数のターゲットに書く。
  public readonly target = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });

  public constructor() { this.target.texture.name = 'diffuseCorrection'; }

  public get texture(): THREE.Texture { return this.target.texture; }

  public at(sample: ShadingSample): Vec3Node { return this.atUv(sample.uv); }

  // デバッグ表示も光源も、最終補正の実テクスチャを直接読む。
  public atUv(uv: Vec2Node): Vec3Node { return texture(this.texture, uv).rgb; }

  // signed 補正の描画先と、その1枚のテクスチャを解放する。
  public dispose(): void { this.target.dispose(); }
}
