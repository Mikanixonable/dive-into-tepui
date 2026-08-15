// HUD の font-family(theme.ts の FONT_FAMILY)は 'JetBrains Mono' → 'HackGen' の順で、
// 前者がラテン字形を、後者が日本語を含む残り全てを担う。太さは 400 のみを読み込み、
// bold 指定はブラウザの合成に任せる。
import '@fontsource/jetbrains-mono/latin-400.css';
import '@sarap422/font-hackgen';
// 低軌道シューティング: エントリポイント。WebGPU シーン初期化・ステージ選択・
// rAF ループ(Game.update → sync → render の駆動)を統括する。
import { createGameScene, GameScene } from './render/scene';
import { Game } from './game/game';
import { PerfMeter } from './perf-meter';
import { FrameSections } from './frame-sections';
import { GpuTimings } from './gpu-timings';
import { GraphicsSettings } from './render/graphics-settings';
import { RenderPipeline } from './render/pipeline/render-pipeline';
import {
  ACCENT, SURFACE_OPAQUE, EDGE, BG, TEXT, TEXT_DIM, FONT_FAMILY,
  FONT_2XL, FONT_M, FONT_XL, RADIUS_S, RADIUS_M,
} from './game/theme';
import { Hud } from './game/hud/hud';
import { PauseMenu } from './game/hud/pause-menu';
import { SettingsView } from './game/hud/settings-view';
import { AudioEngine } from './audio/audio-engine';
import { Bgm } from './audio/bgm';
import { Sfx } from './audio/sfx';
import { UnlockManager } from './game/unlock-manager';
import { LocalStorageSaveStore } from './game/save/save-store';
import { SaveSlots } from './game/save/save-slots';
import { SnapshotService } from './game/save/snapshot-service';
import { AutoSave } from './game/save/autosave';
import { migrateLegacySave } from './game/save/legacy-save';
import { SaveBrowser } from './game/hud/save-browser';
import { SnapshotControls } from './snapshot-controls';
import { Launcher } from './launcher';
import type { StageClass } from './game/stages/stage';
import type { Ephemeris } from './physics/ephemeris';
import type { AttractorId } from './physics/attractor';

// WebGPU 初期化(シェーダーコンパイル等でしばらく無反応になり得る)の間に表示する
// ローディング画面。createGameScene() の await が解決するまでは canvas が
// 真っ黒のままで「固まっている」ように見えるため、先にこれを出しておく。
function showLoading(): () => void {
  const SURFACE = SURFACE_OPAQUE;
  const div = document.createElement('div');
  div.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    `gap:14px;color:${TEXT};background:${BG};font-family:${FONT_FAMILY};z-index:200;text-align:center`;
  div.innerHTML =
    `<div style="font-size:${FONT_2XL};letter-spacing:6px;color:${ACCENT}">Dive into Tepui</div>` +
    `<div style="width:40px;height:40px;border-radius:50%;border:3px solid ${SURFACE};` +
    `border-top-color:${ACCENT};animation:tepui-spin 0.9s linear infinite"></div>` +
    `<div style="font-size:${FONT_M};color:${TEXT_DIM}">初期化中(WebGPU)…</div>`;
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
    `color:${TEXT};background:${BG};font-family:${FONT_FAMILY};font-size:${FONT_XL};text-align:center;line-height:2;z-index:1000`;

  const panel = document.createElement('div');
  panel.style.cssText =
    `max-width:680px;background:${SURFACE_OPAQUE};border:1px solid ${EDGE};border-radius:${RADIUS_M};padding:22px 32px`;

  const heading = document.createElement('div');
  heading.style.color = ACCENT;
  heading.textContent = title;
  panel.appendChild(heading);

  const description = document.createElement('div');
  description.textContent = message;
  panel.appendChild(description);

  const detail = document.createElement('div');
  detail.style.cssText = `color:${TEXT_DIM};font-size:${FONT_M};overflow-wrap:anywhere`;
  detail.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  panel.appendChild(detail);

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.style.cssText =
    `margin-top:14px;padding:8px 18px;color:${TEXT};background:${BG};border:1px solid ${ACCENT};` +
    `border-radius:${RADIUS_S};font:inherit;cursor:pointer`;
  reload.textContent = 'ページを再読み込み';
  reload.addEventListener('click', () => location.reload());
  panel.appendChild(reload);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  reload.focus();
}

// ローディング表示下で canvas を作り WebGPU シーンを初期化する
async function initScene(graphics: GraphicsSettings): Promise<GameScene> {
  hideLoading = showLoading();
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);

  const gs = await createGameScene(canvas, graphics);
  hideLoading();
  hideLoading = null;
  return gs;
}

// ローディング表示の下で、このステージの天体暦を組む。
async function initEphemeris(
  stageClass: StageClass, phaseOffsets: Partial<Record<AttractorId, number>>,
): Promise<Ephemeris> {
  hideLoading = showLoading();
  try {
    return await stageClass.createEphemeris(phaseOffsets);
  } finally {
    hideLoading?.();
    hideLoading = null;
  }
}

// rAF ループを起動する。フレームで例外が起きたらループを止める。
function startAnimationLoop(
  game: Game, perf: PerfMeter, sections: FrameSections, gpu: GpuTimings, autoSave: AutoSave,
  snapshotControls: SnapshotControls, launcher: Launcher,
): void {
  let lastTime = performance.now();
  let completedFrames = 0;
  // 1フレーム分: update → sync → render を実行し、計測後に次フレームを予約する
  function animate(now: number) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    const t0 = perf.on ? performance.now() : 0;
    try {
      sections.beginFrame();
      game.update(dt);
      sections.endFrame();
      // このフレームで Game が消費しなかった入力エッジだけが残っている。
      snapshotControls.handleInput(game.input, game);
      launcher.handleInput(game.input, game);
      perf.handleInput(game.input);
      autoSave.update(game);
      launcher.update(game);
      const t1 = perf.on ? performance.now() : 0;
      game.sync();
      const t2 = perf.on ? performance.now() : 0;
      game.render();
      const t3 = perf.on ? performance.now() : 0;
      // 時刻印クエリを溜めないため、窓の開閉によらず毎フレーム解決させる。計測自身の費用が
      // render 区間へ混ざらないよう、区間の外で呼ぶ。
      gpu.resolve();
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

// hud と音声一式(AudioEngine/Bgm/Sfx)はタイトル(ステージ選択)画面の時点から使えるべき
// なので、Game より先に main.ts が生成して所有し、Game には参照として渡す。pauseMenu も同様に
// main.ts が所有し、開閉に応じた一時停止の反映(game.pause()/game.resume())も持ち主である
// main.ts がここで配線する。
// pipeline はここで組む PauseMenu の描画タブ(GraphicsPanel)がデバッグ表示の選択を書き込む先。
function initHud(graphics: GraphicsSettings, pipeline: RenderPipeline): {
  hud: Hud; audioEngine: AudioEngine; bgm: Bgm; sfx: Sfx; pauseMenu: PauseMenu; settingsView: SettingsView;
} {
  const hud = new Hud();
  const audioEngine = new AudioEngine();
  const bgm = new Bgm(audioEngine);
  const sfx = new Sfx(audioEngine);
  const pauseMenu = new PauseMenu(hud.layers.system, hud.overlayManager, graphics, pipeline);
  const settingsView = new SettingsView(hud.layers.system, hud.overlayManager, bgm);
  pauseMenu.setBgmVolume(bgm.getVolume());
  pauseMenu.onBgmVolumeChange = (vol) => bgm.setVolume(vol);
  return { hud, audioEngine, bgm, sfx, pauseMenu, settingsView };
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
  const graphics = new GraphicsSettings();
  const gs = await initScene(graphics);
  const gpu = new GpuTimings(gs.renderer);
  const pipeline = new RenderPipeline(gs.renderer, graphics, gpu);
  const { hud, audioEngine, bgm, sfx, pauseMenu, settingsView } = initHud(graphics, pipeline);
  const launcher = new Launcher(hud, unlockmanager, slots, snapshotService, sfx, bgm);
  // 「ゲームを中断してタイトル画面に戻る」
  pauseMenu.onQuitToTitle = () => launcher.returnToTitle();
  pauseMenu.onOpenSettings = () => {
    pauseMenu.toggle(false);
    settingsView.toggle(true);
  };
  // タイトル画面にはまだ Game が無いが、ESC メニュー自体はゲームと同じものを使える。
  // Game 生成後も同じコールバックを使うため、ここでは nullable な参照を閉じ込める。
  let game: Game | null = null;
  pauseMenu.onPauseMenuOpenChange = (open) => {
    if (!game) return;
    if (open) game.pause();
    else game.resume();
  };
  settingsView.onOpenChange = (open) => {
    if (!game) return;
    if (open) game.pause();
    else game.resume();
  };
  const stageClass = await launcher.resolveStage(
    () => {
      if (!hud.overlayManager.closeTopmostOnEscape()) pauseMenu.toggle();
    },
    () => pauseMenu.toggle(false),
    () => settingsView.toggle(true),
  );
  const sections = new FrameSections();

  const initialSave = launcher.initialSaveFor(stageClass);
  const ephemeris = await initEphemeris(stageClass, initialSave?.phaseOffsets ?? {});
  // 地球の自転初期位相。起動ごとに無作為だが、下位を決定的に保つため乱数はここでだけ引く。
  const earthSpinPhase0 = initialSave?.earthSpinPhase0 ?? Math.random() * 2 * Math.PI;

  game = new Game(
    gs, stageClass, hud, sfx, pauseMenu, unlockmanager, sections, ephemeris, graphics, pipeline, earthSpinPhase0,
    initialSave,
  );
  launcher.noteLaunched(stageClass);

  // AudioContext は実際のユーザー操作でしか作れないため、unlock は入力エッジの発火点へ配線する。
  // BGM は unlock 後最初の操作で一度だけ自動開始する。
  game.input.onUserGesture = () => {
    audioEngine.unlock();
    bgm.autoStart();
  };

  const saveBrowser = new SaveBrowser(hud.layers.system, slots, snapshotService, game, hud.overlayManager);
  saveBrowser.onSlotSwitched = () => launcher.switchSlot();
  saveBrowser.onLoadSnapshot = (id) => launcher.loadSnapshot(id);
  // 設定メニューと一覧は同じシステム窓の帯にいるので、片方を開くときもう片方は閉じる。
  pauseMenu.onOpenSnapshots = () => {
    pauseMenu.toggle(false);
    saveBrowser.open();
  };
  // ⚙ギアクリック・[閉じる]・[Esc] いずれの経路で開閉しても一時停止フラグを同期する
  const perf = new PerfMeter(game, hud.layers.window, gs.renderer, sections, gpu, hud.overlayManager);
  // 負荷確認ウィンドウは非モーダルなので、設定メニューを閉じてから前面へ出すだけ。
  pauseMenu.onOpenPerfWindow = () => {
    pauseMenu.toggle(false);
    perf.open();
  };
  const snapshotControls = new SnapshotControls(hud, pauseMenu, saveBrowser, snapshotService);
  startAnimationLoop(game, perf, sections, gpu, new AutoSave(snapshotService), snapshotControls, launcher);
}

main().catch((err) => {
  console.error(err);
  showFatalError(
    'ゲームの初期化に失敗しました。',
    'ブラウザやGPUの状態を確認し、ページを再読み込みしてください。',
    err,
  );
});
