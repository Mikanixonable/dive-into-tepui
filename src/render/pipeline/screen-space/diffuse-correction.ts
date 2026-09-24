// 近傍の遮蔽と照り返しを、受け手へ届く符号付き拡散照度の差分として渡す。
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import type { ShadingSample } from '../lighting/shading-sample';
import type { Vec2Node, Vec3Node } from '../../tsl-types';

// 受けた照り返しから、遮られた通常照度を引く。負値もそのまま描画先へ渡す。
export function signedDiffuseCorrection(received: Vec3Node, blocked: Vec3Node): Vec3Node {
  return received.sub(blocked);
}

// 符号付きの拡散照度補正 ΔE_screen の描画先 2 枚 — 走査の解像度で求めた生の値と、描画バッファの解像度へ
// 復元した値。どちらも rgb = ΔE_screen で、負の遮蔽項を保つため半精度浮動小数に書く。
export class DiffuseCorrection {
  // 走査の解像度の、復元前の補正。
  public readonly rawTarget = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  // 描画バッファの解像度の、復元した補正。
  public readonly target = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });

  // 2 枚の出力に名前を付ける。
  public constructor() {
    this.rawTarget.texture.name = 'rawDiffuseCorrection';
    this.target.texture.name = 'diffuseCorrection';
  }

  public get texture(): THREE.Texture { return this.target.texture; }
  public get rawTexture(): THREE.Texture { return this.rawTarget.texture; }

  // sample の画素の、復元した補正。
  public at(sample: ShadingSample): Vec3Node { return this.atUv(sample.uv); }

  // uv(0..1)の位置の、復元した補正。
  public atUv(uv: Vec2Node): Vec3Node { return texture(this.texture, uv).rgb; }

  // 2 枚の描画先を解放する。
  public dispose(): void {
    this.rawTarget.dispose();
    this.target.dispose();
  }
}
