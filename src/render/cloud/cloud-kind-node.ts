// 雲の種類ごとの量から雲頂高度・鉛直柱光学深さ・不透明度を導く曲線の TSL ノード版。
// 基準式と定数は cloud-kind.ts が持ち、ここは同じ式をシェーダグラフへ組む。
import { clamp, exp, log, max, min, sqrt } from 'three/tsl';
import {
  CIRRUS_ALTITUDE_SPAN, CIRRUS_BOTTOM_ALTITUDE, CIRRUS_MAX_OPTICAL_DEPTH,
  CUMULUS_ALTITUDE_SPAN, CUMULUS_BASE_ALTITUDE, CUMULUS_MAX_OPACITY, CUMULUS_OPTICAL_DEPTH_SCALE,
} from './cloud-kind';
import type { FloatNode } from '../tsl-types';

// 積雲の量から雲頂高度 [m]。
export function cumulusTopAltitudeNode(amount: FloatNode): FloatNode {
  return amount.mul(amount).mul(CUMULUS_ALTITUDE_SPAN).add(CUMULUS_BASE_ALTITUDE);
}

// 積雲の量から鉛直柱光学深さ。
export function cumulusColumnOpticalDepthNode(amount: FloatNode): FloatNode {
  return amount.div(CUMULUS_OPTICAL_DEPTH_SCALE);
}

// 積雲の量から不透明度(1 − e^−τ)。
export function cumulusOpacityNode(amount: FloatNode): FloatNode {
  return exp(cumulusColumnOpticalDepthNode(amount).negate()).oneMinus();
}

// 積雲の雲頂高度 [m] から量。高度は式の張る範囲へ clamp する。
export function cumulusAmountFromTopAltitudeNode(altitude: FloatNode): FloatNode {
  return sqrt(clamp(altitude.sub(CUMULUS_BASE_ALTITUDE).div(CUMULUS_ALTITUDE_SPAN), 0, 1));
}

// 積雲の不透明度から量。不透明度は量 1 の値で頭打ちにする。
export function cumulusAmountFromOpacityNode(opacity: FloatNode): FloatNode {
  return log(min(max(opacity, 0), CUMULUS_MAX_OPACITY).oneMinus()).negate()
    .mul(CUMULUS_OPTICAL_DEPTH_SCALE);
}

// 巻雲の量から雲頂高度 [m]。
export function cirrusTopAltitudeNode(amount: FloatNode): FloatNode {
  return amount.mul(CIRRUS_ALTITUDE_SPAN).add(CIRRUS_BOTTOM_ALTITUDE);
}

// 巻雲の量から鉛直柱光学深さ。
export function cirrusColumnOpticalDepthNode(amount: FloatNode): FloatNode {
  return amount.mul(amount).mul(CIRRUS_MAX_OPTICAL_DEPTH);
}

// 巻雲の鉛直柱光学深さから量。光学深さは上限で頭打ちにする。
export function cirrusAmountFromOpticalDepthNode(opticalDepth: FloatNode): FloatNode {
  return sqrt(clamp(opticalDepth.div(CIRRUS_MAX_OPTICAL_DEPTH), 0, 1));
}
