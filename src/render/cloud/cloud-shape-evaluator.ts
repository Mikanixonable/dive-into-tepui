// 雲テクスチャ値を各表現の形状・光学量へ変換する共有評価器。不透明度・雲頂高度・細部・
// 光学的厚みの計算式を集約し、各レンダラーのシェーダーグラフへ展開する。
import { clamp, min, smoothstep } from 'three/tsl';
import { CloudDetailEvaluator, DETAIL_AMPLITUDE_MAX } from './cloud-detail';
import { cumulusColumnOpticalDepthNode } from './cloud-kind-node';
import { CUMULUS_DITHER_KNOB, CLOUD_TOP_SPAN } from './cumulus-shape';
import type { FloatNode, Vec3Node } from '../tsl-types';

const DETAIL_OPACITY_DEPTH = 0.25;
const DETAIL_TOP_RELIEF = 0.15;
const FIELD_TOP_STEP = 1 / 256;
// 細部が覆いへ効き始める不透明度。雲の無い柱は、細部が大きくても覆いが 0 のまま残す。
const DETAIL_GATE_OPACITY = 0.05;

export class CloudShapeEvaluator {
  public static readonly cloudTopUncertainty =
    DETAIL_AMPLITUDE_MAX * DETAIL_TOP_RELIEF + FIELD_TOP_STEP;

  private readonly detail: CloudDetailEvaluator;

  // bodyRadius は雲を載せる天体の基準半径 [m]。細部の段数は 0(細部なし)から始まる。
  public constructor(bodyRadius: FloatNode | number) {
    this.detail = new CloudDetailEvaluator(bodyRadius);
  }

  // 使う細部の段数を置く。
  public setDetailOctaves(count: number): void {
    this.detail.setOctaves(count);
  }

  // 単位方向 direction での、場の texel より細かい起伏 −1..1。width はその位置で読み手の
  // 1 画素・1 タップが張る実寸 [m]、amount はその場所の量、amountAt は任意の方向の量を読む。
  public detailAt(
    direction: Vec3Node, width: FloatNode, amount: FloatNode,
    amountAt: (direction: Vec3Node) => FloatNode,
  ): FloatNode {
    return this.detail.at(direction, width, amount, amountAt);
  }

  // 細部を足してからディザの帯へ通す。空の柱に細部だけで雲を生やさない共有規則である。
  public opaqueFraction(opacity: FloatNode, detail: FloatNode): FloatNode {
    const band = CUMULUS_DITHER_KNOB.halfWidth.mul(2);
    const center = CUMULUS_DITHER_KNOB.center;
    const clampedBand = min(band, center.mul(2));
    const gate = smoothstep(0, DETAIL_GATE_OPACITY, opacity);
    const covered = opacity.add(detail.mul(DETAIL_OPACITY_DEPTH).mul(gate));
    return clamp(covered.sub(center.sub(clampedBand.mul(0.5))).div(clampedBand), 0, 1);
  }

  // 場の雲頂高度(0..1)へ細部を足し、0..1 へ収めた雲頂高度を返す。
  public cloudTop(fieldTop: FloatNode, detail: FloatNode): FloatNode {
    return clamp(fieldTop.add(detail.mul(DETAIL_TOP_RELIEF)), 0, 1);
  }

  // 正規化した雲頂高度を、天体中心からの雲頂の半径(地表の半径 1 基準)へ写す。
  public cloudTopRadius(cloudTop: FloatNode, groundRadius: FloatNode): FloatNode {
    return cloudTop.mul(groundRadius.oneMinus()).add(groundRadius);
  }

  // 積雲の量から鉛直柱光学深さ。
  public columnOpticalDepth(amount: FloatNode): FloatNode {
    return cumulusColumnOpticalDepthNode(amount);
  }

  public get cloudTopSpan(): number { return CLOUD_TOP_SPAN; }
}
