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
import { isStageId } from './game/stages/stage-dictionary';
import { selectLaunch } from './game/launch-select';
import { LaunchSelection } from './game/game-mode';
import { SaveManager } from './game/save-manager';


// ?stage=00|0|1|2 または ?mode=creative で起動選択画面をスキップ(デバッグ・共有リンク用)。
// 指定が無い/不正なら選択画面を出す。
export async function resolveLaunchSelection(unlockManager: UnlockManager): Promise<LaunchSelection> {
  const params = new URLSearchParams(location.search);
  if (params.get('mode') === 'creative') return { mode: 'creative' };
  const stageParam = params.get('stage');
  if (isStageId(stageParam)) return { mode: 'stage', stage: stageParam };
  return selectLaunch(unlockManager);
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
function startAnimationLoop(game: Game, perf: PerfMeter): void {
  let lastTime = performance.now();
  let completedFrames = 0;
  // 1フレーム分: update → sync → render を実行し、計測後に次フレームを予約する
  function animate(now: number) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    const t0 = perf.on ? performance.now() : 0;
    try {
      game.update(dt);
      const t1 = perf.on ? performance.now() : 0;
      game.sync();
      game.render();
      const t2 = perf.on ? performance.now() : 0;
      if (perf.on) {
        perf.record(t1 - t0, t2 - t1, t2);
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
  const settingsPanel = new SettingsPanel(hud.root);
  settingsPanel.setBgmVolume(sfx.getBgmVolume());
  settingsPanel.onBgmVolumeChange = (vol) => sfx.setBgmVolume(vol);
  // 「ゲームを中断してタイトル画面に戻る」— ?stage= クエリを落として選択画面へ
  settingsPanel.onQuitToTitle = () => {
    location.assign(location.pathname);
  };
  return { hud, sfx, settingsPanel };
}

// シーン初期化からステージ選択、Game 構築、rAF ループ開始までを順に行う。
async function main() {
  const unlockmanager = new UnlockManager();
  const gs = await initScene();
  const { hud, sfx, settingsPanel } = initHud();
  const launch = await resolveLaunchSelection(unlockmanager);
  const game = new Game(gs, launch, hud, sfx, settingsPanel, unlockmanager);
  // ⚙ギアクリック・[閉じる]・[Esc] いずれの経路で開閉しても一時停止フラグを同期する
  settingsPanel.onSettingsOpenChange = (open) => {
    if (open) game.pause();
    else game.resume();
  };
  settingsPanel.onSaveGame = () => {
    try {
      SaveManager.save(game);
      settingsPanel.showSaveStatus('セーブしました');
    } catch (e) {
      settingsPanel.showSaveStatus('セーブに失敗しました', true);
    }
  };
  settingsPanel.onLoadGame = () => {
    if (SaveManager.load(game)) {
      settingsPanel.toggle(false); // ロード成功時はメニューを閉じる
    } else {
      settingsPanel.showSaveStatus('ロードに失敗しました', true);
    }
  };
  const perf = new PerfMeter(game);
  startAnimationLoop(game, perf);
}

main().catch((err) => {
  console.error(err);
  showFatalError(
    'ゲームの初期化に失敗しました。',
    'ブラウザやGPUの状態を確認し、ページを再読み込みしてください。',
    err,
  );
});
