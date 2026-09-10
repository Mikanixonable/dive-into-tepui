// HUD の font-family(theme.ts の FONT_FAMILY)は 'JetBrains Mono' → 'HackGen' の順で、
// 前者がラテン字形を、後者が日本語を含む残り全てを担う。太さは 400 を読み込み、bold 指定は
// ブラウザの合成に任せる。
import '@fontsource/jetbrains-mono/latin-400.css';
import './hackgen-400.css';
// 低軌道シューティング: エントリポイント。WebGPU シーン初期化・ステージ選択・
// rAF ループ(Game.update → sync → render の駆動)を統括する。
import { createGameScene, GameScene } from './render/scene';
import { DebugInfoWindow } from './launcher/debug-info-window';
import { FrameSections } from './game/frame-sections';
import { UserSettings } from './settings/user-settings';
import { browserSettingStorage } from './settings/stored-setting';
import { themeIdSetting } from './settings/theme-setting';
import { applyThemePalette } from './theme';
import { Hud } from './game/hud/hud';
import { HudShell } from './hud/hud-shell';
import { PauseMenu } from './hud/windows/pause-menu';
import { SettingsView } from './hud/windows/settings-view';
import { AudioEngine } from './audio/audio-engine';
import { Bgm } from './audio/bgm/bgm';
import { Launcher } from './launcher/launcher';
import { UnlockManager } from './launcher/unlock-manager';
import { SnapshotControls } from './launcher/snapshot-controls';
import { SaveBrowser } from './launcher/save-browser/save-browser';
import { LocalStorageSaveStore } from './launcher/save/save-store';
import { SaveSlots } from './launcher/save/save-slots';
import { SnapshotService } from './launcher/save/snapshot-service';
import { AutoSave } from './launcher/save/autosave';
import { migrateLegacySave } from './launcher/save/legacy-save';
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

  const gs = await createGameScene(canvas, graphics);
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
  // Game が無いフレーム(周回の切り替え中)は何もせず次を予約するだけにする。
  function animate(now: number) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    const game = launcher.current;
    if (game === null) {
      requestAnimationFrame(animate);
      return;
    }
    const t0 = debugInfo.on ? performance.now() : 0;
    try {
      sections.beginFrame();
      game.update(dt);
      sections.endFrame();
      // Game が消費した入力エッジは、この時点で取り除かれている。
      snapshotControls.handleInput(game.input, game);
      launcher.handleInput(game.input);
      // 入力の処理中に周回が畳まれたら(再出撃キーなど)、捨てた Game には触らずこのフレームを終える。
      if (launcher.current !== game) {
        requestAnimationFrame(animate);
        return;
      }
      debugInfo.handleInput(game.input);
      autoSave.update(game);
      const t1 = debugInfo.on ? performance.now() : 0;
      game.sync(graphics.current, renderStyle.current);
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
  pauseMenu: PauseMenu; settingsView: SettingsView;
} {
  const shell = new HudShell();
  const hud = new Hud(shell, settings.renderStyle.current);
  const audioEngine = new AudioEngine();
  const bgm = new Bgm(audioEngine, settings.bgmVolume.current);
  const pauseMenu = new PauseMenu(shell.layers.system, shell.overlayManager, settings.bgmVolume.current);
  const settingsView = new SettingsView(
    shell.layers.system, shell.overlayManager, bgm, settings.graphics.current, settings.bgmVolume.current,
  );
  return { shell, hud, audioEngine, bgm, pauseMenu, settingsView };
}

// 設定の変更を、その値を使う側へ配る。書き換えの入口はどれも設定へ戻し、表示はその通知から引き直す。
function bindSettings(
  settings: UserSettings, gs: GameScene, hud: Hud, bgm: Bgm,
  pauseMenu: PauseMenu, settingsView: SettingsView, debugInfo: DebugInfoWindow,
): void {
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

// 起動時に一度だけ走る、全システムの生成と配線。
async function main() {
  const unlockManager = new UnlockManager();
  const saveStore = new LocalStorageSaveStore();
  const slots = initSaveSlots(saveStore);
  const snapshotService = new SnapshotService(saveStore, slots);
  const settings = new UserSettings(browserSettingStorage);
  const gs = await initScene(settings.graphics.current);
  const { shell, hud, audioEngine, bgm, pauseMenu, settingsView } = initHud(settings);
  const sections = new FrameSections();
  const host: GameHost = {
    scene: gs, hud, sections,
    mapDisplay: settings.mapDisplayToggles,
    grid: settings.gridVisibility,
    orbitGuide: settings.orbitGuide,
  };

  const launcher = new Launcher(
    shell, host, audioEngine, bgm, pauseMenu, settingsView, unlockManager,
    slots, snapshotService, settings.graphics, settings.renderStyle,
  );

  pauseMenu.onQuitToTitle = () => launcher.returnToTitle();
  pauseMenu.onOpenSettings = () => {
    pauseMenu.toggle(false);
    settingsView.toggle(true);
  };
  pauseMenu.onPauseMenuOpenChange = (open) => {
    if (open) launcher.current?.pause();
    else launcher.current?.resume();
  };
  settingsView.onOpenChange = (open) => {
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

  // pipeline はデバッグ情報ウィンドウの描画タブが書き込む先。
  const debugInfo = new DebugInfoWindow(
    shell.layers.window, gs.renderer, sections, gs.gpu, shell.overlayManager, gs.pipeline,
    settings.renderStyle.current,
  );
  bindSettings(settings, gs, hud, bgm, pauseMenu, settingsView, debugInfo);
  pauseMenu.onOpenDebugInfoWindow = () => {
    pauseMenu.toggle(false);
    debugInfo.open();
  };

  const snapshotControls = new SnapshotControls(hud, pauseMenu, saveBrowser, snapshotService);
  pauseMenu.onSave = () => snapshotControls.captureManual(launcher.current);

  await launcher.start();
  settingsView.restorePersistedOpenState();

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
