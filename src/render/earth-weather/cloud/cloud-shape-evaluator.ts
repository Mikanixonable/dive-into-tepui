// 雲テクスチャ値を各表現の形状・光学量へ変換する共有評価器。不透明度・雲頂高度・細部・
// 光学的厚みの計算式を集約し、各レンダラーのシェーダーグラフへ展開する。
import { clamp, float, log2, max, min, smoothstep } from 'three/tsl';
import { CloudDetailEvaluator, DETAIL_AMPLITUDE_MAX } from './cloud-detail';
import { CLOUD_TUNING } from './cloud-tuning';
import { cumulusColumnOpticalDepthNode } from './cloud-kind-node';
import { CUMULUS_DITHER_KNOB, CLOUD_TOP_SPAN } from './cumulus-shape';
import type { CloudSample } from './cloud-field-sample';
import type { FloatNode, Vec2Node, Vec3Node } from '../../tsl-types';

const DETAIL_OPACITY_DEPTH = 0.25;
const DETAIL_TOP_RELIEF = 0.15;
const FIELD_TOP_STEP = 1 / 256;
// 細部が覆いへ効き始める不透明度。雲の無い柱は、細部が大きくても覆いが 0 のまま残す。
const DETAIL_GATE_OPACITY = 0.05;

// 粒の細かさへ効く陸らしさと対流の活発さの重み。
const GRAIN_LAND_WEIGHT = 0.7;
const GRAIN_CONVECTION_WEIGHT = 0.3;
// 粒の細かさへ対流セルの径を混ぜる強さと、その基準径(既定の海洋セル)。基準より小さいセルほど、
// 名目振幅を細かい段へ傾ける分を基準との log2 の差で 0..1 に写して足す — 既定の海では混ぜない。
const CELL_GRAIN_MIX = 0.4;
const CELL_GRAIN_REFERENCE_LOG2 = log2(CLOUD_TUNING.cellMarineKm);

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

  // 表示時刻 displayTime [s] と、実時間 1 秒あたりに進む表示時刻 rate を置く。細部はこの時刻で流れ、生まれ直す。
  public syncClock(displayTime: number, rate: number): void {
    this.detail.syncClock(displayTime, rate);
  }

  // 雲標本の柱での粒の細かさ 0..1。陸で細かく、対流の活発な陸でさらに細かい。海は対流が強くても組織化した
  // 大きな細胞になるので、対流は陸にだけ効かせ、海は粗いまま。そのうえで、基準径より小さい対流セルの空は
  // 粒を細かい側へ足す — 同じ画面密度でもセル径の違う空が違う質感で読める。
  public grainOf(cloud: CloudSample): FloatNode {
    const smallCell = max(CELL_GRAIN_REFERENCE_LOG2.sub(cloud.cumulusCell), 0)
      .div(CELL_GRAIN_REFERENCE_LOG2);
    return clamp(
      cloud.land.mul(cloud.convection.mul(GRAIN_CONVECTION_WEIGHT).add(GRAIN_LAND_WEIGHT))
        .add(float(CELL_GRAIN_MIX).mul(smallCell)),
      0, 1);
  }

  // 単位方向 direction での、場の texel より細かい起伏 −1..1。width はその位置で読み手の
  // 1 画素・1 タップが張る実寸 [m]、amount はその場所の量、amountAt は任意の方向の量を読む。
  // wind はそこで雲を運ぶ風の東・北の成分 [m/s]、grain は粒の細かさ 0..1、cell はその場所の
  // 対流セルの径 log2(km)。
  public detailAt(
    direction: Vec3Node, width: FloatNode, amount: FloatNode,
    amountAt: (direction: Vec3Node) => FloatNode, wind: Vec2Node, grain: FloatNode, cell: FloatNode,
  ): FloatNode {
    return this.detail.at(direction, width, amount, amountAt, wind, grain, cell);
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
