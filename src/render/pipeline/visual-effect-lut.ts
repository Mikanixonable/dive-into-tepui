// 既存のフィルム LUT とは別に、最終表示色へ掛ける固定の視覚効果層を持つ。
// ここで扱うのは環境光が持ち上げた低明度域だけで、照明・材質・影の値は変更しない。
import { dot, float, mix, smoothstep, uniform, vec3 } from 'three/tsl';
import type { FloatUniform, Vec3Node } from '../tsl-types';

export const AMBIENT_SHADOW_LUMA_START = 0.12;
export const AMBIENT_SHADOW_LUMA_END = 0.30;
export const AMBIENT_SHADOW_SATURATION = 0.5;

const REC709 = [0.2126, 0.7152, 0.0722] as const;

export type Rgb = readonly [number, number, number];

// 合成段と同じ作業色空間のRGBへ、暗部彩度抑制を適用するCPU側の正本。
// RGBからRec.709輝度を引き、同じ輝度の無彩色へ補間するので明度は変えない。
export function ambientShadowDesaturation(color: Rgb, enabled: boolean): Rgb {
  if (!enabled) return color;
  const luma = REC709[0] * color[0] + REC709[1] * color[1] + REC709[2] * color[2];
  const t = Math.max(0, Math.min(1,
    (luma - AMBIENT_SHADOW_LUMA_START) / (AMBIENT_SHADOW_LUMA_END - AMBIENT_SHADOW_LUMA_START)));
  const smooth = t * t * (3 - 2 * t);
  const amount = AMBIENT_SHADOW_SATURATION * (1 - smooth);
  return [
    color[0] + (luma - color[0]) * amount,
    color[1] + (luma - color[1]) * amount,
    color[2] + (luma - color[2]) * amount,
  ];
}

// トーンマッピング・フィルム LUT の後に挿す視覚効果層。適用量は環境光と同じ毎フレームの
// 正本から受け、0では恒等変換になる。TSLで式を組むため、通常合成マテリアルを再構築しない。
export class VisualEffectLut {
  private readonly amountUniform: FloatUniform = uniform(0);

  public apply(color: Vec3Node): Vec3Node {
    const luma = dot(color, vec3(REC709[0], REC709[1], REC709[2]));
    const transition = smoothstep(
      float(AMBIENT_SHADOW_LUMA_START), float(AMBIENT_SHADOW_LUMA_END), luma,
    );
    const desaturation = transition.oneMinus().mul(AMBIENT_SHADOW_SATURATION);
    return mix(color, vec3(luma), desaturation.mul(this.amountUniform)) as Vec3Node;
  }

  public setEnabled(enabled: boolean): void {
    this.amountUniform.value = enabled ? 1 : 0;
  }
}
