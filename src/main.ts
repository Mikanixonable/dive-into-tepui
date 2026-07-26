import { createGameScene, GameScene } from './render/scene';
import { Game } from './game/game';
import { PerfMeter } from './perf-meter';
import { ACCENT, SURFACE_OPAQUE, EDGE, BG, TEXT, TEXT_DIM } from './game/theme';
import { Hud } from './game/hud/hud';
import { SettingsPanel } from './game/hud/settings-panel';
import { Sfx } from './audio/sfx';
import { UnlockManager } from './game/unlock-manager';
import { StageId } from './game/stages/stage';
import { isStageId } from './game/stages/stage-dictionary';
import { selectStage } from './game/stages/stage-select';


// ?stage=00|0|1|2 で選択画面をスキップ(デバッグ・共有リンク用)。指定が無い/不正なら選択画面を出す。
export async function resolveStageSelection(unlockManager: UnlockManager): Promise<StageId> {
  const stageParam = new URLSearchParams(location.search).get('stage');
  if (isStageId(stageParam)) return stageParam;
  return selectStage(unlockManager);
}
// 低軌道シューティング: エントリポイント。
// 物理はメインスレッドで毎フレーム積分する(単体エンティティの中心重力
// RK4 は十分軽い)。src/physics/nbody/physics.worker.ts の N体ワーカーは
// 将来のシスルナ(太陽-地球-月)フェーズ用に残してあり、現在は未使用。

// WebGPU 初期化(シェーダーコンパイル等でしばらく無反応になり得る)の間に表示する
// ローディング画面。createGameScene() の await が解決するまでは canvas が
// 真っ黒のままで「固まっている」ように見えるため、先にこれを出しておく。
function showLoading(): () => void {
  const SURFACE = SURFACE_OPAQUE;
  const div = document.createElement('div');
  div.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    `gap:14px;color:${TEXT};background:${BG};font-family:Consolas,monospace;z-index:200;text-align:center`;
  div.innerHTML =
    `<div style="font-size:22px;letter-spacing:6px;color:${ACCENT}">DIVE INTO TEPUI</div>` +
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

function startAnimationLoop(game: Game, perf: PerfMeter): void {
  let lastTime = performance.now();
  let crashed = false;
  function animate(now: number) {
    if (crashed) return;
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    const t0 = perf.on ? performance.now() : 0;

    try {
      game.update(dt);
    } catch (err) {
      crashed = true;
      console.error('Fatal error in game.update:', err);
    }

    const t1 = perf.on ? performance.now() : 0;

    try {
      if (!crashed) game.sync(Math.min(dt, 0.1));
    } catch (err) {
      crashed = true;
      console.error('Fatal error in game.sync:', err);
    }

    try {
      if (!crashed) game.render();
    } catch (err) {
      crashed = true;
      console.error('Fatal error in game.render:', err);
    }

    const t2 = perf.on ? performance.now() : 0;
    if (perf.on && !crashed) {
      perf.record(t1 - t0, t2 - t1, t2);
    }
    if (!crashed) requestAnimationFrame(animate);
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
  settingsPanel.setBgmState(sfx.isBgmEnabled());
  settingsPanel.onBgmToggle = (on) => sfx.setBgmEnabled(on);
  // 「ゲームを中断してタイトル画面に戻る」— ?stage= クエリを落として選択画面へ
  settingsPanel.onQuitToTitle = () => {
    location.assign(location.pathname);
  };
  return { hud, sfx, settingsPanel };
}

async function main() {
  const unlockmanager = new UnlockManager();
  // レンダラ初期化
  const gs = await initScene();
  const { hud, sfx, settingsPanel } = initHud();
  // ステージ決定とゲーム生成
  const stageId = await resolveStageSelection(unlockmanager);
  const game = new Game(gs, stageId, hud, sfx, settingsPanel, unlockmanager);
  // ⚙ギアクリック・[閉じる]・[Esc] いずれの経路で開閉しても一時停止フラグを同期する
  settingsPanel.onSettingsOpenChange = (open) => {
    if (open) game.pause();
    else game.resume();
  };
  // パフォーマンス計測の DOM
  const perf = new PerfMeter(game);
  // rAF ループ開始
  startAnimationLoop(game, perf);
}

main().catch((err) => {
  console.error(err);
  hideLoading?.();
  const div = document.createElement('div');
  div.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    `color:${TEXT};background:${BG};font-family:monospace;font-size:16px;text-align:center;line-height:2`;
  div.innerHTML =
    `<div style="background:${SURFACE_OPAQUE};border:1px solid ${EDGE};border-radius:4px;padding:22px 32px">` +
    `<span style="color:${ACCENT}">WebGPU の初期化に失敗しました。</span><br>` +
    'Chrome / Edge 最新版など WebGPU 対応ブラウザでアクセスしてください。<br>' +
    `<span style="color:${TEXT_DIM};font-size:12px">${String(err)}</span></div>`;
  document.body.appendChild(div);
});
