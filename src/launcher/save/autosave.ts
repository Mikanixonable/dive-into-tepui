import { SnapshotService, type SnapshotCaptureSource } from './snapshot-service';

// 「いつ復帰点を更新するか」だけを持つ。
const AUTOSAVE_INTERVAL_REAL_SEC = 60;

export class AutoSave {
  private intervalOriginReal = performance.now();

  public constructor(private readonly service: SnapshotService) {}

  // ランが始まったときに呼ぶ。その場で復帰点を更新し、次までの間隔をここから数え直す。
  public beginRun(source: SnapshotCaptureSource): void {
    this.capture(source, performance.now());
  }

  // 毎フレーム呼ぶ。ラン開始か前回から AUTOSAVE_INTERVAL_REAL_SEC 秒(実時間)経っていれば更新する。
  public update(source: SnapshotCaptureSource): void {
    const now = performance.now();
    if ((now - this.intervalOriginReal) / 1000 < AUTOSAVE_INTERVAL_REAL_SEC) return;
    this.capture(source, now);
  }

  private capture(source: SnapshotCaptureSource, now: number): void {
    this.intervalOriginReal = now;
    // 停止中は状態が動かない。決着後を残さないのは SAVE.md の規定。
    if (source.isPaused || !source.isPlaying) return;
    this.service.writeResumePoint(source.serialize());
  }
}
