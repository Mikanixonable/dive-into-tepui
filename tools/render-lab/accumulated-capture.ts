// 描画テスト環境の、近傍拡散補正の履歴を本番のジッターの列で積んでから撮る撮影。
import type { LabView } from './lab';
import { phasesOf } from './phase-sequence';

let comparisonImageSequence = 0;
const comparisonImages = new Map<string, string>();

// 本番のジッター列で履歴の上限ぶん描き、履歴が落ち着いた絵を撮って PNG のデータ URL で返す。shotName は撮ったものの
// 名前で、落ち着かなかったときの例外に添える。終わると源と論理フレームを呼ぶ前のものへ戻し、その番号で履歴を切る。
export async function captureAccumulated(view: LabView, shotName: string): Promise<string> {
  const previousAutomaticJitter = view.automaticJitterIsEnabled;
  const previousFrame = view.logicalFrame;
  const historyCap = view.historyCapFrames;
  try {
    // 読み込み途中の絵を履歴へ入れないよう、先に落ち着いた状態を描く。
    await view.captureSettled(`${shotName} before accumulation`);
    view.setAutomaticJitterEnabled(true);
    // 最初の番号で履歴を切り、残りを連続番号として積む。
    for (let frame = 0; frame < historyCap; frame++) {
      view.setFrame(frame, frame === 0 ? Number.POSITIVE_INFINITY : 0);
    }
    return await view.captureSettled(shotName);
  } finally {
    view.setAutomaticJitterEnabled(previousAutomaticJitter);
    view.setFrame(previousFrame, Number.POSITIVE_INFINITY);
  }
}

export interface HistoryAccumulationComparison {
  readonly requestedReferenceFrames: number;
  readonly results: readonly {
    readonly historyCap: number;
    readonly accumulatedFrames: number;
    readonly referenceFrames: number;
    readonly rmse: number;
    readonly maxAbsoluteError: number;
    readonly comparedChannels: number;
    readonly referenceImageKey: string;
    readonly imageKey: string;
  }[];
}

// 履歴上限 8・16・32 の蓄積を、同じ走査ジッターの平均 correction と比較する。各組で 4 s フレーム蓄積する。
// 誤差の数値と、別呼び出しで取得できる符号付き補正画像のキーを返す。
export async function compareHistoryAccumulation(
  view: LabView, referenceFrames = 128,
): Promise<HistoryAccumulationComparison> {
  if (!Number.isInteger(referenceFrames) || referenceFrames < 32 || referenceFrames > 512) {
    throw new RangeError(`render-lab: invalid reference frame count ${referenceFrames}`);
  }
  const previousAutomaticJitter = view.automaticJitterIsEnabled;
  const previousFrame = view.logicalFrame;
  const caps = [8, 16, 32] as const;
  comparisonImages.clear();
  const comparisonId = ++comparisonImageSequence;
  try {
    const results: HistoryAccumulationComparison['results'][number][] = [];

    for (const historyCap of caps) {
      const accumulatedFrames = historyCap * 4;
      const averageFrames = Math.max(referenceFrames, accumulatedFrames);
      // 上限 1 では時間履歴を混ぜないため、平均は同じ位相列の空間補正だけを集める。
      view.setHistoryCapForComparison(1);
      await view.captureSettled(`history accumulation reference s=${historyCap}`);
      const depth = await view.readFloat('depth');
      const reference = await view.averageCorrection(phasesOf({
        sources: ['seed', 'scanRepresentative'], count: averageFrames,
      }, view.scanCellSize));
      const referenceImageKey = `history-${comparisonId}-reference-${historyCap}`;
      comparisonImages.set(referenceImageKey, await view.signedCorrectionPng(reference));

      view.setHistoryCapForComparison(historyCap);
      view.setAutomaticJitterEnabled(true);
      for (let frame = 0; frame < accumulatedFrames; frame++) {
        view.setFrame(frame, frame === 0 ? Number.POSITIVE_INFINITY : 0);
      }
      const accumulated = await view.readFloat('correction');
      if (accumulated.width !== reference.width || accumulated.height !== reference.height) {
        throw new Error('render-lab: temporal correction dimensions differ from the average');
      }
      let squaredError = 0;
      let maximum = 0;
      let comparedChannels = 0;
      for (let pixel = 0; pixel < reference.rgba.length; pixel += 4) {
        const surfaceDepth = depth.rgba[pixel]!;
        if (!Number.isFinite(surfaceDepth) || surfaceDepth <= 0) continue;
        for (let channel = 0; channel < 3; channel++) {
          const expected = reference.rgba[pixel + channel]!;
          const actual = accumulated.rgba[pixel + channel]!;
          if (!Number.isFinite(expected) || !Number.isFinite(actual)) continue;
          const difference = actual - expected;
          squaredError += difference * difference;
          maximum = Math.max(maximum, Math.abs(difference));
          comparedChannels++;
        }
      }
      if (comparedChannels === 0) throw new Error('render-lab: correction comparison has no finite channels');
      const imageKey = `history-${comparisonId}-s${historyCap}`;
      comparisonImages.set(imageKey, await view.signedCorrectionPng(accumulated));
      results.push({
        historyCap,
        accumulatedFrames,
        referenceFrames: averageFrames,
        rmse: Math.sqrt(squaredError / comparedChannels),
        maxAbsoluteError: maximum,
        comparedChannels,
        referenceImageKey,
        imageKey,
      });
    }
    return { requestedReferenceFrames: referenceFrames, results };
  } finally {
    view.setHistoryCapForComparison(null);
    view.setAutomaticJitterEnabled(previousAutomaticJitter);
    view.setFrame(previousFrame, Number.POSITIVE_INFINITY);
  }
}

// compareHistoryAccumulation が返した 1 枚の画像を、個別に取得する。
export function historyAccumulationComparisonImage(key: string): string {
  const image = comparisonImages.get(key);
  if (image === undefined) throw new Error(`render-lab: no comparison image "${key}"`);
  return image;
}
