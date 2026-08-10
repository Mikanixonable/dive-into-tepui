import '@fontsource/jetbrains-mono';
import '@sarap422/font-hackgen';
// 低軌道シューティング: エントリポイント。WebGPU シーン初期化・ステージ選択・
// rAF ループ(Game.update → sync → render の駆動)を統括する。
import { createGameScene, GameScene } from './render/scene';
import { Game } from './game/game';
import { PerfMeter } from './perf-meter';
import { ACCENT, SURFACE_OPAQUE, EDGE, BG, TEXT, TEXT_DIM, FONT } from './game/theme';
import { Hud } from './game/hud/hud';
import { SettingsPanel } from './game/hud/settings-panel';
import { Sfx } from './audio/sfx';
import { UnlockManager } from './game/unlock-manager';
import { ephemerisConfigFor, isStageId, STAGE_DEFINITIONS } from './game/stages/stage-dictionary';
import type { StageId } from './game/stages/stage';
import { selectLaunch } from './game/launch-select';
import { LaunchSelection } from './game/game-mode';
import { LocalStorageSaveStore } from './game/save/save-store';
import { SaveSlots } from './game/save/save-slots';
import { SnapshotService } from './game/save/snapshot-service';
import { AutoSave } from './game/save/autosave';
import { migrateLegacySave } from './game/save/legacy-save';
import { SaveBrowser } from './game/hud/save-browser';
import { SIM_EPOCH_JD_TDB } from './game/sim-epoch';
import { loadAbsoluteEphemeris } from './physics/ephemeris-catalog';
import { profileAt } from './physics/ephemeris-profile';


// アクティブスロットの直近起動が今も選択可能(ロック解除済み・選択画面から隠されていない)か判定する
function isResumableStage(unlockManager: UnlockManager, stageId: string): boolean {
  if (!isStageId(stageId)) return false;
  const stage = STAGE_DEFINITIONS.find((s) => s.id === stageId);
  return stage !== undefined && !stage.hiddenFromSelect && unlockManager.isUnlocked(stageId);
}

// アクティブスロットの直近起動を再開する選択を返す。再開できる情報が無ければ null。
function resumeFromActiveSlot(unlockManager: UnlockManager, slots: SaveSlots): LaunchSelection | null {
  const slot = slots.activeSlot();
  if (slot === null) return null;
  if (slot.mode === 'creative') return { mode: 'creative' };
  return isResumableStage(unlockManager, slot.lastStageId)
    ? { mode: 'stage', stage: slot.lastStageId as StageId }
    : null;
}

// ?title=1 は選択画面へ強制する。?mode=creative/?stage= は共有リンク・デバッグ用の
// 明示指定として最優先。どちらも無ければアクティブスロットの直近起動を再開し、
// それも無ければ選択画面を出す。
export async function resolveLaunchSelection(
  unlockManager: UnlockManager, slots: SaveSlots,
): Promise<LaunchSelection> {
  const params = new URLSearchParams(location.search);
  if (params.get('title') === '1') return selectLaunch(unlockManager);
  if (params.get('mode') === 'creative') return { mode: 'creative' };
  const stageParam = params.get('stage');
  if (isStageId(stageParam)) return { mode: 'stage', stage: stageParam };
  return resumeFromActiveSlot(unlockManager, slots) ?? selectLaunch(unlockManager);
}

// WebGPU 初期化(シェーダーコンパイル等でしばらく無反応になり得る)の間に表示する
// ローディング画面。createGameScene() の await が解決するまでは canvas が
// 真っ黒のままで「固まっている」ように見えるため、先にこれを出しておく。
function showLoading(): () => void {
  const SURFACE = SURFACE_OPAQUE;
  const div = document.createElement('div');
  div.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    `gap:14px;color:${TEXT};background:${BG};font-family:${FONT};z-index:200;text-align:center`;
  div.innerHTML =
    `<div style="font-size:22px;letter-spacing:6px;color:${ACCENT}">Dive into Tepui</div>` +
    `<div style="width:40px;height:40px;border-radius:50%;border:3px solid ${SURFACE};` +
    `border-top-color:${ACCENT};animation:tepui-spin 0.9s linear infinite"></div>` +
    `<div style="font-size:12px;color:${TEXT_DIM}">初期化中(WebGPU)…</div>`;
  const style = document.createElement('style');
  style.textContent = '@keyframes tepui-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
  document.body.appendChild(div);
  return () => {
    div.remove();
    style.remove();
  };
}

let hideLoading: (() => void) | null = null;

// 初期化中・実行中を問わず、継続不能な例外は画面内で明示する。
// 壊れた Game/renderer を同一ページ内で再利用せず、復旧はページ全体の再読込だけにする。
function showFatalError(title: string, message: string, error: unknown): void {
  hideLoading?.();
  hideLoading = null;
  if (document.getElementById('fatal-error-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'fatal-error-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;' +
    `color:${TEXT};background:${BG};font-family:${FONT};font-size:16px;text-align:center;line-height:2;z-index:1000`;

  const panel = document.createElement('div');
  panel.style.cssText =
    `max-width:680px;background:${SURFACE_OPAQUE};border:1px solid ${EDGE};border-radius:4px;padding:22px 32px`;

  const heading = document.createElement('div');
  heading.style.color = ACCENT;
  heading.textContent = title;
  panel.appendChild(heading);

  const description = document.createElement('div');
  description.textContent = message;
  panel.appendChild(description);

  const detail = document.createElement('div');
  detail.style.cssText = `color:${TEXT_DIM};font-size:12px;overflow-wrap:anywhere`;
  detail.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  panel.appendChild(detail);

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.style.cssText =
    `margin-top:14px;padding:8px 18px;color:${TEXT};background:${BG};border:1px solid ${ACCENT};` +
    `border-radius:3px;font:inherit;cursor:pointer`;
  reload.textContent = 'ページを再読み込み';
  reload.addEventListener('click', () => location.reload());
  panel.appendChild(reload);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  reload.focus();
}

// ローディング表示下で canvas を作り WebGPU シーンを初期化する
async function initScene(): Promise<GameScene> {
  hideLoading = showLoading();
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);

  const gs = await createGameScene(canvas);
  hideLoading();
  hideLoading = null;
  return gs;
}

// rAF ループを起動する。フレームで例外が起きたらループを止める。
function startAnimationLoop(game: Game, perf: PerfMeter, autoSave: AutoSave): void {
  let lastTime = performance.now();
  let completedFrames = 0;
  // 1フレーム分: update → sync → render を実行し、計測後に次フレームを予約する
  function animate(now: number) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    const t0 = perf.on ? performance.now() : 0;
    try {
      game.update(dt);
      autoSave.update(game);
      const t1 = perf.on ? performance.now() : 0;
      game.sync();
      const t2 = perf.on ? performance.now() : 0;
      game.render();
      const t3 = perf.on ? performance.now() : 0;
      if (perf.on) {
        perf.record(t1 - t0, t2 - t1, t3 - t2, t3);
      }
      completedFrames++;
      // Dependency-free browser smoke test が「例外なく60フレーム完走」を判定する印。
      // 60フレーム目に一度だけDOMへ書き、通常プレイ中の毎フレーム更新は避ける。
      if (completedFrames === 60) document.documentElement.dataset.gameReady = 'true';
      requestAnimationFrame(animate);
    } catch (e) {
      console.error('Fatal error in animation loop, stopping game loop:', e);
      showFatalError(
        'ゲームの実行中にエラーが発生しました。',
        '安全のためゲームを停止しました。ページを再読み込みしてください。',
        e,
      );
    }
  }
  requestAnimationFrame((now) => {
    lastTime = now;
    animate(now);
  });
}

// hud/sfx はタイトル(ステージ選択)画面の時点から使えるべきなので、Game より先に main.ts が
// 生成して所有し、Game には参照として渡す。settingsPanel も同様に main.ts が所有し、開閉に
// 応じた一時停止の反映(game.pause()/game.resume())も持ち主である main.ts がここで配線する。
function initHud(): { hud: Hud; sfx: Sfx; settingsPanel: SettingsPanel } {
  const hud = new Hud();
  const sfx = new Sfx();
  const settingsPanel = new SettingsPanel(hud.layers.system, hud.modalController);
  settingsPanel.setBgmVolume(sfx.getBgmVolume());
  settingsPanel.onBgmVolumeChange = (vol) => sfx.setBgmVolume(vol);
  // 「ゲームを中断してタイトル画面に戻る」— ?title=1 を付けて選択画面へ強制する
  settingsPanel.onQuitToTitle = () => {
    location.assign(`${location.pathname}?title=1`);
  };
  return { hud, sfx, settingsPanel };
}

// シーン初期化からステージ選択、Game 構築、rAF ループ開始までを順に行う。
// 索引を読み、旧セーブを取り込み、遊ぶ先のスロットが必ず1つある状態にする。
function initSaveSlots(store: LocalStorageSaveStore): SaveSlots {
  const slots = new SaveSlots(store);
  slots.pruneOrphans();
  const migrated = migrateLegacySave(slots);
  if (slots.activeSlotId === null) {
    slots.setActiveSlot((migrated ?? slots.slots[0] ?? slots.createSlot('セーブデータ 1')).id);
  }
  return slots;
}

async function main() {
  const unlockmanager = new UnlockManager();
  const saveStore = new LocalStorageSaveStore();
  const slots = initSaveSlots(saveStore);
  const snapshotService = new SnapshotService(saveStore, slots);
  const gs = await initScene();
  const { hud, sfx, settingsPanel } = initHud();
  const launch = await resolveLaunchSelection(unlockmanager, slots);
  let absoluteEphemeris;
  // 固有の簡易天体暦を指定するデバッグステージには外部 pack を読み込まない。
  // 通常起動では開始時刻からプロファイルを決定するため、開始時刻を変更しても
  // プロファイル ID を別途ハードコードし直す必要がない。
  if (ephemerisConfigFor(launch) === undefined) {
    hideLoading = showLoading();
    try {
      const profile = profileAt(SIM_EPOCH_JD_TDB);
      absoluteEphemeris = await loadAbsoluteEphemeris(
        profile.id,
        SIM_EPOCH_JD_TDB,
        SIM_EPOCH_JD_TDB + 10 * 365.25,
      );
    } finally {
      hideLoading?.();
      hideLoading = null;
    }
  }
  const game = new Game(
    gs, launch, hud, sfx, settingsPanel, unlockmanager, snapshotService, absoluteEphemeris,
  );
  const activeSlotId = slots.activeSlotId;
  if (activeSlotId !== null) slots.noteLaunch(activeSlotId, launch.mode, game.activeStage.id);

  // アクティブスロットの現在ステージにある最新スナップショットを起動時に復元する。
  // 本体の欠損・バージョン不一致・ステージ不一致は SnapshotService.restore() に
  // 判定させ、復元できない場合は通常の新規起動状態をそのまま使う。
  if (activeSlotId !== null) {
    const latest = slots.latestSnapshot(activeSlotId, game.activeStage.id);
    if (latest !== null) snapshotService.restore(game, latest.id);
  }

  const saveBrowser = new SaveBrowser(hud.layers.system, slots, snapshotService, game, hud.modalController);
  game.setSaveBrowser(saveBrowser);
  saveBrowser.onSlotSwitched = () => location.assign(location.pathname);
  // 設定メニューと一覧は同じシステム窓の帯にいるので、片方を開くときもう片方は閉じる。
  settingsPanel.onOpenSnapshots = () => {
    settingsPanel.toggle(false);
    saveBrowser.open();
  };
  // ⚙ギアクリック・[閉じる]・[Esc] いずれの経路で開閉しても一時停止フラグを同期する
  settingsPanel.onSettingsOpenChange = (open) => {
    if (open) game.pause();
    else game.resume();
  };
  const perf = new PerfMeter(game);
  startAnimationLoop(game, perf, new AutoSave(snapshotService));
}

main().catch((err) => {
  console.error(err);
  showFatalError(
    'ゲームの初期化に失敗しました。',
    'ブラウザやGPUの状態を確認し、ページを再読み込みしてください。',
    err,
  );
});
