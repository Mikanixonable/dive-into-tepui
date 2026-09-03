// HUD の font-family(theme.ts の FONT_FAMILY)は 'JetBrains Mono' → 'HackGen' の順で、
// 前者がラテン字形を、後者が日本語を含む残り全てを担う。太さは 400 のみを読み込み、
// bold 指定はブラウザの合成に任せる。
import '@fontsource/jetbrains-mono/latin-400.css';
import '@sarap422/font-hackgen';
// 低軌道シューティング: エントリポイント。WebGPU シーン初期化・ステージ選択・
// rAF ループ(Game.update → sync → render の駆動)を統括する。
import { createGameScene, GameScene } from './render/scene';
import { PerfMeter } from './launcher/perf-meter';
import { FrameSections } from './game/frame-sections';
import { GraphicsSettings, type GraphicsSettingsData } from './render/graphics-settings';
import { RenderStyleSetting } from './render/render-style';
import { Hud } from './game/hud/hud';
import { HudShell } from './hud/hud-shell';
import { PauseMenu, SettingsView } from './hud/windows/index';
import { startProteinAssetPreload } from './game/protein/protein-asset-loader';
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
  launcher: Launcher, gs: GameScene, graphics: GraphicsSettings, renderStyle: RenderStyleSetting,
  perf: PerfMeter, sections: FrameSections,
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
    const t0 = perf.on ? performance.now() : 0;
    try {
      sections.beginFrame();
      game.update(dt, graphics.current);
      sections.endFrame();
      // このフレームで Game が消費しなかった入力エッジだけが残っている。
      snapshotControls.handleInput(game.input, game);
      launcher.handleInput(game.input);
      // 入力の処理中に周回が畳まれたら(再出撃キーなど)、捨てた Game には触らずこのフレームを終える。
      if (launcher.current !== game) {
        requestAnimationFrame(animate);
        return;
      }
      perf.handleInput(game.input);
      autoSave.update(game);
      const t1 = perf.on ? performance.now() : 0;
      game.sync(graphics.current, renderStyle.current);
      const t2 = perf.on ? performance.now() : 0;
      game.render(renderStyle.current);
      const t3 = perf.on ? performance.now() : 0;
      // 時刻印クエリを溜めないため、窓の開閉によらず毎フレーム解決させる。計測自身の費用が
      // render 区間へ混ざらないよう、区間の外で呼ぶ。
      gs.gpu.resolve();
      if (perf.on) {
        perf.record(game, t1 - t0, t2 - t1, t3 - t2, t3);
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

// hud と AudioEngine/Bgm はタイトル(ステージ選択)画面の時点から使えるべきなので、
// Game より先に main.ts が生成して所有し、Launcher には参照として渡す。
// pauseMenu も同様に main.ts が所有し、開閉に応じた一時停止の反映
// (launcher.current?.pause()/resume())も持ち主である main.ts がここで配線する。
function initHud(graphics: GraphicsSettings, renderStyle: RenderStyleSetting): {
  shell: HudShell; hud: Hud; audioEngine: AudioEngine; bgm: Bgm;
  pauseMenu: PauseMenu; settingsView: SettingsView;
} {
  const shell = new HudShell();
  const hud = new Hud(shell, renderStyle);
  const audioEngine = new AudioEngine();
  const bgm = new Bgm(audioEngine);
  const pauseMenu = new PauseMenu(shell.layers.system, shell.overlayManager);
  const settingsView = new SettingsView(shell.layers.system, shell.overlayManager, bgm, graphics);
  pauseMenu.setBgmVolume(bgm.getVolume());
  pauseMenu.onBgmVolumeChange = (vol) => bgm.setVolume(vol);
  return { shell, hud, audioEngine, bgm, pauseMenu, settingsView };
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

async function main() {
  // シーン初期化と並行して、タンパク質アセット(構造・モーション)の fetch を非同期に始める。
  // 完了前にタンパク質型の敵を生成する側(DynamicSystem.spawnEnemyWhenReady)が待つ。
  startProteinAssetPreload();
  const unlockmanager = new UnlockManager();
  const saveStore = new LocalStorageSaveStore();
  const slots = initSaveSlots(saveStore);
  const snapshotService = new SnapshotService(saveStore, slots);
  const graphics = new GraphicsSettings();
  const renderStyle = new RenderStyleSetting();
  const gs = await initScene(graphics.current);
  // 描画品質設定の押し出し先の登録は、設定を持っている側の配線。
  graphics.bind(gs);
  const { shell, hud, audioEngine, bgm, pauseMenu, settingsView } = initHud(graphics, renderStyle);
  const sections = new FrameSections();

  const launcher = new Launcher(
    shell, hud, gs, audioEngine, bgm, pauseMenu, settingsView, unlockmanager, sections,
    slots, snapshotService,
  );


  // 「ゲームを中断してタイトル画面に戻る」
  pauseMenu.onQuitToTitle = () => launcher.returnToTitle();
  pauseMenu.onOpenSettings = () => {
    pauseMenu.toggle(false);
    settingsView.toggle(true);
  };
  // タイトル画面にはまだ Game が無いので、launcher.current は null を返す。
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

  // pipeline は負荷確認ウィンドウのデバッグ表示の選択欄が書き込む先。
  const perf = new PerfMeter(
    shell.layers.window, gs.renderer, sections, gs.gpu, shell.overlayManager, gs.pipeline, renderStyle,
  );
  // 負荷確認ウィンドウは非モーダルなので、設定メニューを閉じてから前面へ出すだけ。
  pauseMenu.onOpenPerfWindow = () => {
    pauseMenu.toggle(false);
    perf.open();
  };

  const snapshotControls = new SnapshotControls(hud, pauseMenu, saveBrowser, snapshotService);
  pauseMenu.onSave = () => snapshotControls.captureManual(launcher.current);

  await launcher.start();
  settingsView.restorePersistedOpenState();

  startAnimationLoop(launcher, gs, graphics, renderStyle, perf, sections, new AutoSave(snapshotService), snapshotControls);
}

main().catch((err) => {
  console.error(err);
  showFatalError(
    'ゲームの初期化に失敗しました。',
    'ブラウザやGPUの状態を確認し、ページを再読み込みしてください。',
    err,
  );
});
