// 低気圧の谷の配置の系列を時刻で標本化し、生まれてから消えるまでの一生へ切り分ける道具。
// render/cloud の配置と谷の回帰テストが共有する。
import type { CyclonePlacement } from '../../src/render/cloud/cyclone-tracks';

// 標本の刻み [s]。低気圧の一生(4 日以上)を数十点で、熱帯低気圧の一生(7 日以上)を百数十点で追える細かさ。
export const SAMPLE_STEP = 3600;

// 時刻 [s] → 配置の 1 系列。
export type Placements = (seconds: number) => CyclonePlacement | null;

// 系列を 0 から days 日ぶん SAMPLE_STEP 刻みで辿った標本。
export function sampled(at: Placements, days: number): readonly (CyclonePlacement | null)[] {
  return Array.from({ length: Math.floor((days * 86400) / SAMPLE_STEP) + 1 }, (_, i) => at(i * SAMPLE_STEP));
}

// 標本の中で生まれてから消えるまでを丸ごと含む一生(null に挟まれた non-null の連なり)。
// 標本の端で切れている一生は含めない。
export function completeLives(samples: readonly (CyclonePlacement | null)[]): readonly (readonly CyclonePlacement[])[] {
  const lives: CyclonePlacement[][] = [];
  let current: CyclonePlacement[] = [];
  // 最初の null を見るまでは、標本の頭で切れた一生の途中なので集めない。
  let bornInside = false;
  for (const sample of samples) {
    if (sample === null) {
      if (current.length > 0) lives.push(current);
      current = [];
      bornInside = true;
    } else if (bornInside) {
      current.push(sample);
    }
  }
  return lives;
}
