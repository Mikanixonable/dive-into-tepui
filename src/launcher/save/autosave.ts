// 自動セーブを更新する頃合いを実時間で数え、その時が来た周回の状態を SnapshotService へ渡す。
import { SnapshotService, type SnapshotSource } from './snapshot-service';

const AUTOSAVE_INTERVAL_REAL_SEC = 60;

export class AutoSave {
  private intervalOriginReal = performance.now();

  public constructor(private readonly service: SnapshotService) {}

  // ランが始まったときに呼ぶ。その場で自動セーブを更新し、次までの間隔をここから数え直す。
  public beginRun(source: SnapshotSource): void {
    this.intervalOriginReal = performance.now();
    this.writeAutoSave(source);
  }

  // 毎フレーム呼ぶ。間隔の起点から AUTOSAVE_INTERVAL_REAL_SEC 秒(実時間)経っていれば更新する。
  public update(source: SnapshotSource): void {
    const now = performance.now();
    if ((now - this.intervalOriginReal) / 1000 < AUTOSAVE_INTERVAL_REAL_SEC) return;
    this.intervalOriginReal = now;
    this.writeAutoSave(source);
  }

  // いま残せる状態であれば、自動セーブをこの瞬間へ差し替える。
  private writeAutoSave(source: SnapshotSource): void {
    // 停止中は状態が動かない。決着後を残さないのは SAVE.md の規定。
    if (source.isPaused || !source.isPlaying) return;
    this.service.writeAutoSave(source.serialize());
  }
}
