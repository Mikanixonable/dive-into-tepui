// 描画テスト環境の、近傍拡散補正の履歴を本番のジッターの列で積んでから撮る撮影。
import type { JitterSource } from '../../src/render/pipeline/screen-space/frame-jitter';
import type { LabView } from './lab';

// 積むあいだ番号由来ジッターに使わせる源 — 本番と同じ。
const ACCUMULATION_SOURCES: readonly JitterSource[] = ['seed', 'scanRepresentative'];

// 本番のジッター列で履歴の上限ぶん描き、履歴が落ち着いた絵を撮って PNG のデータ URL で返す。shotName は撮ったものの
// 名前で、落ち着かなかったときの例外に添える。終わると源と論理フレームを呼ぶ前のものへ戻し、その番号で履歴を切る。
export async function captureAccumulated(view: LabView, shotName: string): Promise<string> {
  const previousSources = view.jitterSources;
  const previousFrame = view.logicalFrame;
  const historyCap = view.historyCapFrames;
  try {
    // 読み込み途中の絵を履歴へ入れないよう、先に落ち着いた状態を描く。
    await view.captureSettled(`${shotName} before accumulation`);
    view.setJitterSources(ACCUMULATION_SOURCES);
    // 最初の番号で履歴を切り、残りを連続番号として積む。
    for (let frame = 0; frame < historyCap; frame++) {
      view.setFrame(frame, frame === 0 ? Number.POSITIVE_INFINITY : 0);
    }
    return await view.captureSettled(shotName);
  } finally {
    view.setJitterSources(previousSources);
    view.setFrame(previousFrame, Number.POSITIVE_INFINITY);
  }
}
