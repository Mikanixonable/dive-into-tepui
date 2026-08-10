// HDR 出力の露出制御。ここにはカメラや THREE の状態を持ち込まず、将来の
// histogram / average-luminance 測定器も同じ適応則を共有できるようにする。

export interface ExposureAdaptation {
  readonly min: number;
  readonly max: number;
  // 明るくする/暗くする適応の e-folding 時間 [s]。急なカメラ切替で露出が跳ねないよう、
  // 明順応を遅く、暗順応をやや速くする。
  readonly brightenSeconds: number;
  readonly darkenSeconds: number;
}

export const CELESTIAL_EXPOSURE: ExposureAdaptation = {
  min: 0.65,
  max: 1.35,
  brightenSeconds: 2.8,
  darkenSeconds: 1.1,
};

// Phase 1 では測光用の画面ヒストグラムをまだ導入しない。太陽・昼側地球・月を同時に
// 扱える中立露出を固定の目標にし、以後のフェーズが target だけを差し替えられる形にする。
export const NEUTRAL_CELESTIAL_EXPOSURE = 1.0;

/** 画面の支配的な線形輝度推定から露出目標を得る。GPU readbackを避ける低コスト測光器用。 */
export function exposureTargetForLuminance(relativeLuminance: number): number {
  const luminance = Number.isFinite(relativeLuminance) ? Math.max(0.02, relativeLuminance) : 0.18;
  return clampExposure(0.92 * Math.sqrt(0.32 / luminance));
}

export function clampExposure(exposure: number, limits: ExposureAdaptation = CELESTIAL_EXPOSURE): number {
  return Math.min(limits.max, Math.max(limits.min, exposure));
}

// 一次遅れで current を target へ追従させる。dt が大きくても過走しないため、タブ復帰や
// ビュー切替直後でも露出を瞬時に飛ばさない。
export function adaptExposure(
  current: number,
  target: number,
  dt: number,
  limits: ExposureAdaptation = CELESTIAL_EXPOSURE,
): number {
  const safeCurrent = clampExposure(Number.isFinite(current) ? current : NEUTRAL_CELESTIAL_EXPOSURE, limits);
  const safeTarget = clampExposure(Number.isFinite(target) ? target : NEUTRAL_CELESTIAL_EXPOSURE, limits);
  const safeDt = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 1));
  const seconds = safeTarget > safeCurrent ? limits.brightenSeconds : limits.darkenSeconds;
  const mix = 1 - Math.exp(-safeDt / seconds);
  return clampExposure(safeCurrent + (safeTarget - safeCurrent) * mix, limits);
}

// レンダラへの書き込みは scene.ts に閉じ、ゲーム側はこの状態をフレーム時間だけで進める。
// target はカメラ種別ではなく測光結果から与える契約なので、戦闘/マップ切替そのものでは
// 露出が変わらない。
export class ExposureController {
  private value = NEUTRAL_CELESTIAL_EXPOSURE;

  get current(): number { return this.value; }

  update(dt: number, target = NEUTRAL_CELESTIAL_EXPOSURE): number {
    this.value = adaptExposure(this.value, target, dt);
    return this.value;
  }
}
