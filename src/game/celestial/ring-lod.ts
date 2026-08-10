// 環の帯を面(annulus)または線(line)で描くLOD。線へ落としてもalphaを固定値へ上げず、
// 画面被覆率を同じ物理透過へ掛けて、ズームアウトで総光量が増えないようにする。
import { ringPixelCoverage } from '../../physics/ring-optics';

export type RingVisualForm = 'annulus' | 'line';
export type RingLod = {
  readonly form: RingVisualForm;
  readonly coverage: number;
  readonly annulusWeight: number;
  readonly lineWeight: number;
};

const RING_LINE_THRESHOLD_PX = 1;

export function ringVisualForm(bandWidthMeters: number, metersPerPixelAtBand: number): RingVisualForm {
  return bandWidthMeters / metersPerPixelAtBand < RING_LINE_THRESHOLD_PX ? 'line' : 'annulus';
}

export function ringLod(bandWidthMeters: number, metersPerPixelAtBand: number): RingLod {
  const pixels = metersPerPixelAtBand > 0 ? bandWidthMeters / metersPerPixelAtBand : 0;
  const coverage = ringPixelCoverage(bandWidthMeters, metersPerPixelAtBand);
  // 0.75〜1.25pxでクロスフェードし、二つの表現の重みの和を1にする。
  const lineWeight = pixels <= 0.75 ? 1 : pixels >= 1.25 ? 0 : (1.25 - pixels) / 0.5;
  return {
    form: ringVisualForm(bandWidthMeters, metersPerPixelAtBand),
    coverage,
    annulusWeight: 1 - lineWeight,
    lineWeight,
  };
}
