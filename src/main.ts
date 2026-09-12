// 低軌道シューティング: エントリポイント。WebGPU シーン初期化・ステージ選択・
// rAF ループ(Game.update → sync → render の駆動)を統括する。
// HUD の書体(ラテン字形の JetBrains Mono、日本語を含む残りの HackGen)を太さ 400 で読み込む。
// bold 指定はブラウザの合成に任せる。
import '@fontsource/jetbrains-mono/latin-400.css';
import './hackgen-400.css';
import { createGameScene, GameScene } from './render/scene';
import { browserViewport } from './render/viewport';
import { DebugInfoWindow } from './game/hud/windows/debug-info-window';
import { FrameSections } from './game/frame-sections';
import { UserSettings } from './settings/user-settings';
import { browserSettingStorage } from './settings/stored-setting';
import { themeIdSetting } from './settings/theme-setting';
import { applyThemePalette } from './theme';
import { Hud } from './game/hud/hud';
import { HudShell } from './hud/hud-shell';
import { PauseMenu } from './hud/windows/pause-menu';
import { AudioEngine } from './audio/audio-engine';
import { Bgm } from './audio/bgm/bgm';
import { debugInfoOpenAtStart, Launcher } from './launcher/launcher';
import { UnlockManager } from './launcher/unlock-manager';
import { SnapshotControls } from './launcher/snapshot-controls';
import { SaveBrowser } from './launcher/save-browser/save-browser';
import { LocalStorageSaveStore } from './launcher/save/save-store';
import { SaveSlots } from './launcher/save/save-slots';
import { SnapshotService } from './launcher/save/snapshot-service';
import { AutoSave } from './launcher/save/autosave';
import { showLoading, hideLoading } from './launcher/loading-overlay';
import { showFatalError } from './launcher/fatal-error';
import type { GameHost } from './game/game-host';
import type { GraphicsSettingsData } from './render/graphics-settings';
import type { RenderStyle } from './render/render-style';
import type { SettingValue } from './settings/stored-setting';

// ローディング表示下で canvas を作り WebGPU シーンを初期化する
async function initScene(graphics: GraphicsSettingsData): Promise<GameScene> {
  showLoading();
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);

  const gs = await createGameScene(canvas, graphics, browserViewport());
  hideLoading();
  return gs;
}

// rAF ループを起動する。フレームで例外が起きたらループを止める。
function startAnimationLoop(
  launcher: Launcher, gs: GameScene,
  graphics: SettingValue<GraphicsSettingsData>, renderStyle: SettingValue<RenderStyle>,
  debugInfo: DebugInfoWindow, sections: FrameSections,
  autoSave: AutoSave,
  snapshotControls: SnapshotControls,
): void {
  let lastTime = performance.now();
  let completedFrames = 0;
  // 1フレーム分: update → sync → render を実行し、計測後に次フレームを予約する。
  function animate(now: number) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    // 描画先の寸法はフレームの先頭で1度だけ読む。投影・尺度・ポインタ座標が同じ矩形を見ないと、
    // リサイズしたフレームで画面上の当たり判定がずれる。
    const viewport = browserViewport();
    gs.syncViewport(viewport);
    const game = launcher.currentGame;
    const current = launcher.current;
    // 周回の切り替え中は Game が無いので、次フレームを予約して抜ける。
    if (game === null || current === null) {
      requestAnimationFrame(animate);
      return;
    }
    const t0 = debugInfo.on ? performance.now() : 0;
    try {
      sections.beginFrame();
      game.update(dt, viewport);
      sections.endFrame();
      // Game が消費した入力エッジは、この時点で取り除かれている。
      snapshotControls.handleInput(game.input, current.snapshot);
      launcher.handleInput(game.input);
      // 入力の処理中に周回が畳まれたら(再出撃キーなど)、捨てた Game には触らずこのフレームを終える。
      if (launcher.currentGame !== game) {
        requestAnimationFrame(animate);
        return;
      }
      debugInfo.handleInput(game.input);
      autoSave.update(current.snapshot);
      const t1 = debugInfo.on ? performance.now() : 0;
      game.sync(graphics.current, renderStyle.current, viewport);
      const t2 = debugInfo.on ? performance.now() : 0;
      game.render(renderStyle.current);
      const t3 = debugInfo.on ? performance.now() : 0;
      // 時刻印クエリを溜めないため、窓の開閉によらず毎フレーム解決させる。計測自身の費用が
      // render 区間へ混ざらないよう、区間の外で呼ぶ。
      gs.gpu.resolve();
      if (debugInfo.on) {
        debugInfo.record(game, t1 - t0, t2 - t1, t3 - t2, t3);
      }
      completedFrames++;
      // 例外なく60フレーム完走したことを、外から読めるようにする印。
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

// タイトル(ステージ選択)画面の時点から使えるべき画面と音声を、Game より先に組む。
// 各部品は設定の現在値を構築時に受け取り、以後の変更は main が配線する。
function initHud(settings: UserSettings): {
  shell: HudShell; hud: Hud; audioEngine: AudioEngine; bgm: Bgm;
  pauseMenu: PauseMenu;
} {
  const shell = new HudShell();
  const hud = new Hud(shell, settings.renderStyle.current);
  const audioEngine = new AudioEngine();
  const bgm = new Bgm(audioEngine, settings.bgmVolume.current);
  const pauseMenu = new PauseMenu(
    shell.layers.system, shell.overlayManager, bgm, settings.graphics.current, settings.bgmVolume.current,
  );
  return { shell, hud, audioEngine, bgm, pauseMenu };
}

// 設定の変更を、その値を使う側へ配る。書き換えの入口はどれも設定へ戻し、表示はその通知から引き直す。
function bindSettings(
  settings: UserSettings, gs: GameScene, hud: Hud, bgm: Bgm,
  pauseMenu: PauseMenu, debugInfo: DebugInfoWindow,
): void {
  const settingsView = pauseMenu.settingsView;
  settings.graphics.subscribe((graphics) => gs.applyGraphics(graphics));
  settingsView.onGraphicsChange = (graphics) => settings.graphics.set(graphics);

  settings.renderStyle.subscribe((style) => debugInfo.syncRenderStyle(style));
  hud.onRenderStyleChange = (style) => settings.renderStyle.set(style);

  // 音量は一時停止メニューと設定ビューの両方が書き換えるので、通知を受けた側で両方を引き直す。
  settings.bgmVolume.subscribe((volume) => {
    bgm.setVolume(volume);
    pauseMenu.syncBgmVolume(volume);
    settingsView.syncBgmVolume(volume);
  });
  pauseMenu.onBgmVolumeChange = (volume) => settings.bgmVolume.set(volume);
  settingsView.onBgmVolumeChange = (volume) => settings.bgmVolume.set(volume);

  // 配色は DOM へ適用できたものだけを選択として残す。
  settingsView.onThemeIdChange = (id) => {
    if (applyThemePalette(id)) themeIdSetting.set(id);
  };
}

// 起動時に一度だけ走る、全システムの生成と配線。
async function main() {
  // セーブと設定を読み、シーンと HUD を組む。
  const unlockManager = new UnlockManager();
  const saveStore = new LocalStorageSaveStore();
  const slots = SaveSlots.load(saveStore);
  const snapshotService = new SnapshotService(saveStore, slots);
  const settings = new UserSettings(browserSettingStorage);
  const gs = await initScene(settings.graphics.current);
  const { shell, hud, audioEngine, bgm, pauseMenu } = initHud(settings);
  const sections = new FrameSections();
  const host: GameHost = {
    scene: gs, hud, sections,
    mapDisplay: settings.mapDisplayToggles,
    grid: settings.gridVisibility,
    orbitGuide: settings.orbitGuide,
  };

  // 周回の遷移と、一時停止メニューからの導線。
  const launcher = new Launcher(
    shell, host, audioEngine, bgm, pauseMenu, unlockManager,
    slots, snapshotService, settings.graphics, settings.renderStyle,
  );

  pauseMenu.onQuitToTitle = () => launcher.returnToTitle();
  pauseMenu.onPauseMenuOpenChange = (open) => {
    if (open) launcher.current?.pause();
    else launcher.current?.resume();
  };

  const saveBrowser = new SaveBrowser(shell.layers.system, slots, snapshotService, launcher, shell.overlayManager);
  saveBrowser.onSlotSwitched = () => launcher.switchSlot();
  saveBrowser.onLoadSnapshot = (id) => launcher.loadSnapshot(id);
  // 設定メニューと一覧は同じシステム窓の帯にいるので、片方を開くときもう片方は閉じる。
  pauseMenu.onOpenSaveBrowser = () => {
    pauseMenu.toggle(false);
    saveBrowser.open();
  };

  // デバッグ情報ウィンドウと、設定の配線。
  const debugInfo = new DebugInfoWindow(
    shell.layers.window, gs.renderer, sections, gs.gpu, shell.overlayManager, gs.pipeline,
    settings.renderStyle.current, debugInfoOpenAtStart(),
  );
  bindSettings(settings, gs, hud, bgm, pauseMenu, debugInfo);
  pauseMenu.onOpenDebugInfoWindow = () => {
    pauseMenu.toggle(false);
    debugInfo.open();
  };

  const snapshotControls = new SnapshotControls(hud, pauseMenu, saveBrowser, snapshotService);
  pauseMenu.onSave = () => snapshotControls.captureManual(launcher.current?.snapshot ?? null);

  // 最初の周回を起こしてから、フレームを回し始める。
  await launcher.start();
  startAnimationLoop(
    launcher, gs, settings.graphics, settings.renderStyle, debugInfo, sections,
    new AutoSave(snapshotService), snapshotControls,
  );
}

main().catch((err) => {
  console.error(err);
  showFatalError(
    'ゲームの初期化に失敗しました。',
    'ブラウザやGPUの状態を確認し、ページを再読み込みしてください。',
    err,
  );
});
