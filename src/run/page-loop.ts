// ページの rAF ループ。フレームごとに、ページの寿命の装置(描画先の寸法・一時停止メニュー・BGM)を
// 引き直し、周回があればそのフレームを回して進行を launcher へ返す。周回の中の位相の順序は Run が持つ。
import { browserViewport } from '../render/viewport';
import { gameCommand } from '../game/input/game-input-types';
import { KEY_MAPPING as K } from '../input-devices/key-mapping';
import { fmtElapsedUnits } from '../hud-kit/format';
import { showFatalError } from '../launcher/fatal-error';
import type { GameInputPort } from '../game/input/game-input-router';
import type { Bgm } from '../audio/bgm/bgm';
import type { Launcher } from '../launcher/launcher';
import type { SnapshotControls } from '../launcher/snapshot-controls';
import type { UserSettings } from '../settings/user-settings';
import type { PageDevices } from './page-devices';

// 画面の更新間隔の揺れを吸収する余裕 [ms]。120 Hz の 1 フレーム(8.3 ms)の半分 — 30 fps の上限で
// 60 Hz の画面なら 2 回に 1 回が確実に描かれ、揺れで 1 回余計に見送って 20 fps へ落ちることがない。
const FRAME_INTERVAL_SLACK_MS = 4;

// 例外なく回し終えたら、起動の完了として外から読める印を立てるフレーム数。
const READY_FRAME_COUNT = 60;

// 前に描いたフレームの時刻 lastDrawnMs から nowMs までが、上限 capFps の間隔に届いていなければ真。
// capFps が 0 なら上限なし(常に偽)。
function skipsFrame(nowMs: number, lastDrawnMs: number, capFps: number): boolean {
  if (capFps <= 0) return false;
  return nowMs - lastDrawnMs < 1000 / capFps - FRAME_INTERVAL_SLACK_MS;
}

export class PageLoop {
  // 周回が消費しなかった入力エッジを、周回の外で優先度順に受ける窓口。どの周回にも同じものを渡す。
  private readonly outsidePorts: readonly GameInputPort[];
  // 最後に描いたフレームの時刻 [ms]。上限で見送ったフレームでは進めず、実時間を次に描くフレームの
  // dt へ繰り越す — そうすれば上限はシミュレーション時間の進みを変えない。
  private lastDrawnMs = 0;
  private completedFrames = 0;

  // layoutSmoke はレイアウトのスモーク検査が駆動しているページか。layoutSmokeHud は
  // ?layout-smoke=hud で、描画資源を組まず常に描画を行わない検査の経路か。
  public constructor(
    private readonly launcher: Launcher,
    private readonly devices: PageDevices,
    private readonly settings: UserSettings,
    private readonly bgm: Bgm,
    snapshotControls: SnapshotControls,
    private readonly layoutSmoke: boolean,
    private readonly layoutSmokeHud: boolean,
  ) {
    // 手動セーブと一覧の開閉、決着後の再出撃、デバッグ情報の窓の順に優先する。
    this.outsidePorts = [
      {
        feature: 'snapshot',
        commands: [
          gameCommand(K.manualSave.code, K.manualSave),
          gameCommand(K.openSaveBrowser.code, K.openSaveBrowser),
        ],
        handleCommand: command => snapshotControls.handleCommand(command.id, launcher.current?.snapshot ?? null),
      },
      {
        feature: 'launcher',
        isEnabled: () => launcher.current?.isPlaying === false,
        commands: [gameCommand(K.restart.code, K.restart)],
        handleCommand: command => launcher.handleCommand(command.id),
      },
      {
        feature: 'debug-info',
        commands: [gameCommand(K.toggleDebugInfoWindow.code, K.toggleDebugInfoWindow)],
        handleCommand: command => devices.debugInfo.handleCommand(command.id),
      },
    ];
  }

  // 次の rAF から回し始める。最初のフレームの dt は 0 になる。
  public start(): void {
    requestAnimationFrame((now) => {
      this.lastDrawnMs = now;
      this.tick(now);
    });
  }

  // rAF のコールバック。上限で見送るか、1フレームを回して次を予約する。例外が出たらループを止めて
  // 画面に出す — 壊れた状態で回し続けると、セーブまで壊れた状態を書き込む。
  private readonly tick = (now: number): void => {
    if (!skipsFrame(now, this.lastDrawnMs, this.settings.resolvedGraphics.current.frameRateCap)) {
      const dt = (now - this.lastDrawnMs) / 1000;
      this.lastDrawnMs = now;
      try {
        this.frame(dt, now);
      } catch (e) {
        console.error('Fatal error in animation loop, stopping game loop:', e);
        showFatalError(
          'ゲームの実行中にエラーが発生しました。',
          '安全のためゲームを停止しました。ページを再読み込みしてください。',
          e,
        );
        return;
      }
    }
    // 見送ったフレームも次を予約する。
    requestAnimationFrame(this.tick);
  };

  // 1フレーム: ページの装置を引き直し、周回があればそのフレームを回す。dt [s] は実時間の経過、
  // now [ms] はフレームの先頭で1度だけ読んだ実時刻。
  private frame(dt: number, now: number): void {
    const { devices, settings, launcher } = this;
    // 描画先の寸法はフレームの先頭で1度だけ読む。投影・尺度・ポインタ座標が同じ矩形を見ないと、
    // リサイズしたフレームで画面上の当たり判定がずれる。
    const viewport = browserViewport();
    // ?layout-smoke=hud は常に描画を行わず、?layout-smoke はスモーク検査が凍結を求めたとき
    // 入力と HUD の同期は回したまま、寸法の変化に伴う headless WebGPU の再確保と描画だけを止める。
    const hudOnly = this.layoutSmokeHud
      || (this.layoutSmoke && document.documentElement.dataset.layoutSmokeFreeze === 'true');
    if (!hudOnly) devices.scene.syncFrame(viewport, settings.resolvedGraphics.current, devices.debugInfo.debugTarget);
    // 設定面と BGM はタイトル画面でも使うので、周回の有無を見る前に引き直す。BGM は、前のフレームまでに
    // 決まった周回の進行と、設定面の試聴に合わせる。
    const pauseMenu = devices.pauseMenu;
    pauseMenu.sync(now);
    const run = launcher.current;
    pauseMenu.syncSession(run === null ? null : { stageLabel: run.stageLabel, elapsed: fmtElapsedUnits(run.game.simTime) });
    this.bgm.sync({
      volume: settings.audibleBgmVolume,
      inRun: run?.isPlaying ?? false,
      audition: pauseMenu.settingsView.bgmAudition,
    });
    // 周回の切り替え中は周回が無い。
    if (run === null) return;
    if (!run.frame(dt, now, viewport, this.outsidePorts, !hudOnly)) return;
    launcher.followProgress();
    this.completedFrames++;
    if (this.completedFrames === READY_FRAME_COUNT) document.documentElement.dataset.gameReady = 'true';
  }
}
