// エントリポイント。ページに1つずつの装置(シーン・HUD・音声・セーブ)と周回の遷移を組んで配線し、
// rAF ループでランのフレームを回す。
// HUD の書体は太さ 400 だけを読み、bold はブラウザの合成に任せる。
import '@fontsource/jetbrains-mono/latin-400.css';
import './hackgen-400.css';
import { createGameScene, type GameScene } from './render/scene';
import { browserViewport } from './render/viewport';
import { DebugInfoWindow } from './game/hud/windows/debug-info-window';
import { FrameSections } from './game/frame-sections';
import { UserSettings } from './settings/user-settings';
import { browserSettingStorage } from './settings/stored-setting';
import { themePresetOf } from './theme';
import { applyThemeVariables } from './hud/style/theme-variables';
import { Hud } from './game/hud/hud';
import { PanelCollapse } from './game/hud/panel-shell';
import { HudShell } from './hud/hud-shell';
import { MarkerDevice } from './marker/marker-device';
import { injectMarkerIdentityStyle } from './game/marker/marker-identity-style';
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
import { gameCommand } from './game/input/game-commands';
import { KEY_MAPPING as K } from './input/key-mapping';
import type { PageDevices } from './run/page-devices';
import type { ViewOptionsSettings } from './game/hud/panels/view-options-control';
import type { GraphicsSettingsData } from './render/graphics-settings';

// ローディング表示下で canvas を作り WebGPU シーンを初期化する
async function initScene(graphics: GraphicsSettingsData): Promise<GameScene> {
  showLoading();
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);

  const gameScene = await createGameScene(canvas, graphics, browserViewport());
  hideLoading();
  return gameScene;
}

// rAF ループを起動する。フレームで例外が起きたらループを止める。
function startAnimationLoop(
  launcher: Launcher, gameScene: GameScene, settings: UserSettings, bgm: Bgm,
  debugInfo: DebugInfoWindow, pauseMenu: PauseMenu, snapshotControls: SnapshotControls,
): void {
  const layoutSmoke = new URLSearchParams(window.location.search).has('layout-smoke');
  let lastTime = performance.now();
  let completedFrames = 0;
  // 1フレーム分: ランのフレームを回し、次フレームを予約する。
  function animate(now: number) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    // 描画先の寸法はフレームの先頭で1度だけ読む。投影・尺度・ポインタ座標が同じ矩形を見ないと、
    // リサイズしたフレームで画面上の当たり判定がずれる。
    const viewport = browserViewport();
    // layout smoke は起動完了後も入力・HUD同期を動かすが、viewport変更に伴う
    // headless WebGPU の再確保だけ止める。通常実行では常に従来どおり同期・描画する。
    const hudOnlyFrame = layoutSmoke
      && document.documentElement.dataset.layoutSmokeFreeze === 'true';
    if (!hudOnlyFrame) gameScene.syncFrame(viewport, settings.graphics.current, debugInfo.debugTarget);
    // 設定面と BGM はタイトル画面でも使うので、周回の有無を見る前に引き直す。BGM は、前のフレームまでに
    // 決まった周回の進行と、設定面の試聴に合わせる。
    pauseMenu.sync(now);
    const run = launcher.current;
    bgm.sync({
      volume: settings.audibleBgmVolume,
      inRun: run?.isPlaying ?? false,
      audition: pauseMenu.settingsView.bgmAudition,
    });
    // 周回の切り替え中はランが存在しないため、次フレームを予約して早期リターンする。
    if (run === null) {
      requestAnimationFrame(animate);
      return;
    }
    try {
      // ランが消費しなかった入力エッジを、ラン外の優先度順で処理するハンドラ登録。
      const completed = run.frame(dt, now, viewport, [
        {
          feature: 'snapshot',
          commands: [
            gameCommand(K.manualSave.code, K.manualSave),
            gameCommand(K.openSaveBrowser.code, K.openSaveBrowser),
          ],
          handleCommand: command => snapshotControls.handleCommand(command.id, run.snapshot),
        },
        {
          feature: 'launcher',
          isEnabled: () => !run.game.activeStage.isPlaying,
          commands: [gameCommand(K.restart.code, K.restart)],
          handleCommand: command => launcher.handleCommand(command.id),
        },
        {
          feature: 'debug-info',
          commands: [gameCommand(K.toggleDebugInfoWindow.code, K.toggleDebugInfoWindow)],
          handleCommand: command => debugInfo.handleCommand(command.id),
        },
      ], !hudOnlyFrame);
      if (completed) {
        launcher.followProgress();
        completedFrames++;
        // 例外なく60フレーム完走したことを、外から読めるようにする印。
        if (completedFrames === 60) document.documentElement.dataset.gameReady = 'true';
      }
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

// タイトル(ステージ選択)画面の時点から使えるべき画面と音声を、ランより先に組む。
// 各部品は設定の現在値を構築時に受け取り、以後の変更は main が配線する。
function initHud(settings: UserSettings): {
  shell: HudShell; hud: Hud; markers: MarkerDevice; audioEngine: AudioEngine; bgm: Bgm;
  pauseMenu: PauseMenu;
} {
  const shell = new HudShell();
  const panelCollapse = new PanelCollapse(
    settings.panelCollapsed, (state) => settings.panelCollapsed.set(state),
  );
  const hud = new Hud(shell, panelCollapse, settings.renderStyle.current);
  // マーカーの骨格は装置が、種別ごとの見た目は表示の導出が注入する。骨格を先に置き、
  // 同じ詳細度であれば種別ごとのスタイル指定が優先される順序にする。
  const markers = new MarkerDevice(shell.layers.marker);
  injectMarkerIdentityStyle();
  const audioEngine = new AudioEngine();
  const bgm = new Bgm(audioEngine);
  const pauseMenu = new PauseMenu(
    shell.layers.system, shell.overlayManager,
    settings.graphics.current, settings.audibleBgmVolume, settings.themePalette.current.id,
  );
  return { shell, hud, markers, audioEngine, bgm, pauseMenu };
}

// 設定の変更を、通知を受け取る各コンポーネントへ伝播する。書き換えの入口はどれも設定へ戻す。
function bindSettings(
  settings: UserSettings, hud: Hud, pauseMenu: PauseMenu, debugInfo: DebugInfoWindow,
): void {
  const settingsView = pauseMenu.settingsView;
  settingsView.onGraphicsChange = (graphics) => settings.graphics.set(graphics);

  settings.renderStyle.subscribe((style) => {
    debugInfo.syncRenderStyle(style);
    hud.syncRenderStyle(style);
  });

  // 音量は一時停止メニューと設定ビューの両方が書き換えるので、通知を受けた側で両方を引き直す。
  // どちらも消音中は音量を 0 と見せる。
  const syncBgmVolume = (): void => {
    pauseMenu.syncBgmVolume(settings.audibleBgmVolume);
    settingsView.syncBgmVolume(settings.audibleBgmVolume);
  };
  settings.bgmVolume.subscribe(syncBgmVolume);
  settings.bgmMuted.subscribe(syncBgmVolume);
  pauseMenu.onBgmVolumeChange = (volume) => settings.setBgmVolume(volume);
  settingsView.onBgmVolumeChange = (volume) => settings.setBgmVolume(volume);
  pauseMenu.onBgmMutedChange = (muted) => settings.setBgmMuted(muted);

  // 配色はプリセットに在るものだけを選択として残す。
  settingsView.onThemeIdChange = (id) => {
    const palette = themePresetOf(id);
    if (palette !== null) settings.themePalette.set(palette);
  };
}

// 表示パネルが読み書きする設定を、読み取り専用プロパティと更新コールバックに分けて束ねる。
function viewOptionsSettings(settings: UserSettings): ViewOptionsSettings {
  return {
    // 読み取り専用プロパティ。
    mapDisplay: settings.mapDisplayToggles,
    grid: settings.gridVisibility,
    tab: settings.viewOptionsTab,
    orbitGuideGroupTab: settings.orbitGuideGroupTab,
    renderStyle: settings.renderStyle,
    // 更新コールバック。設定の正本へ反映する。
    onMapDisplayChange: (value) => settings.mapDisplayToggles.set(value),
    onGridChange: (value) => settings.gridVisibility.set(value),
    onTabChange: (value) => settings.viewOptionsTab.set(value),
    onOrbitGuideGroupTabChange: (value) => settings.orbitGuideGroupTab.set(value),
    onRenderStyleChange: (value) => settings.renderStyle.set(value),
  };
}

// 起動時に一度だけ走る、全システムの生成と配線。
async function main() {
  // 設定を読み、選ばれている配色を :root へ適用してからでなければ、ローディング表示も
  // ステージ選択画面も色を引けない。
  const settings = new UserSettings(browserSettingStorage);
  settings.themePalette.subscribe((palette) => applyThemeVariables(palette));
  // セーブを読み、シーンと HUD を組む。
  const unlockManager = new UnlockManager();
  const saveStore = new LocalStorageSaveStore();
  const slots = SaveSlots.load(saveStore);
  const snapshotService = new SnapshotService(saveStore, slots);
  const autoSave = new AutoSave(snapshotService);
  const gameScene = await initScene(settings.graphics.current);
  const { shell, hud, markers, audioEngine, bgm, pauseMenu } = initHud(settings);
  const sections = new FrameSections();
  const debugInfo = new DebugInfoWindow(
    shell.layers.window, gameScene.renderer, sections, gameScene.gpu, shell.overlayManager,
    settings.renderStyle.current, debugInfoOpenAtStart(),
  );
  const devices: PageDevices = { scene: gameScene, hud, markers, audioEngine, pauseMenu, debugInfo };

  // 周回の遷移と、一時停止メニューからの導線。
  const launcher = new Launcher(
    shell, devices, viewOptionsSettings(settings), settings.themePalette, sections, unlockManager,
    slots, snapshotService, autoSave, settings.graphics, settings.renderStyle,
  );

  pauseMenu.onQuitToTitle = () => launcher.returnToTitle();

  const saveBrowser = new SaveBrowser(shell.layers.system, slots, snapshotService, launcher, shell.overlayManager);
  saveBrowser.onSlotSwitched = () => launcher.switchSlot();
  saveBrowser.onLoadSnapshot = (id) => launcher.loadSnapshot(id);
  // 設定メニューと一覧は同じシステム窓の帯にいるので、片方を開くときもう片方は閉じる。
  pauseMenu.onOpenSaveBrowser = () => {
    pauseMenu.toggle(false);
    saveBrowser.open();
  };

  // 設定とデバッグ情報ウィンドウの配線。
  bindSettings(settings, hud, pauseMenu, debugInfo);
  pauseMenu.onOpenDebugInfoWindow = () => {
    pauseMenu.toggle(false);
    debugInfo.open();
  };

  const snapshotControls = new SnapshotControls(hud, pauseMenu, saveBrowser, snapshotService);
  pauseMenu.onSave = () => snapshotControls.saveManually(launcher.current?.snapshot ?? null);

  // 最初のタイトル画面でも設定面と BGM を引き直すため、周回を起こす前からフレームを回す。
  startAnimationLoop(launcher, gameScene, settings, bgm, debugInfo, pauseMenu, snapshotControls);
  await launcher.start();
}

main().catch((err) => {
  console.error(err);
  showFatalError(
    'ゲームの初期化に失敗しました。',
    'ブラウザやGPUの状態を確認し、ページを再読み込みしてください。',
    err,
  );
});
