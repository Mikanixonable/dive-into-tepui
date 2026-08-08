import { Game } from '../game';
import { SnapshotService } from './snapshot-service';

// 「いつ自動で撮るか」だけを持つ。実際の撮影(GameSaveData の組み立て・永続化)は
// SnapshotService に委ねる。
export const AUTOSAVE_INTERVAL_REAL_SEC = 60;

export class AutoSave {
  private lastCaptureReal = performance.now();

  constructor(private readonly service: SnapshotService) {}

  // 毎フレーム呼ぶ。前回の撮影から AUTOSAVE_INTERVAL_REAL_SEC 秒(実時間)経っていれば1件撮る。
  update(game: Game): void {
    const now = performance.now();
    if ((now - this.lastCaptureReal) / 1000 < AUTOSAVE_INTERVAL_REAL_SEC) return;
    this.capture(game, now);
  }

  private capture(game: Game, now: number): void {
    this.lastCaptureReal = now;
    // 停止中は状態が動かないうえ、一覧を開いたまま剪定が走ると見ている行が消える。
    if (game.isPaused || !game.activeStage.isPlaying) return;
    this.service.capture(game, 'auto', null, false);
  }
}
