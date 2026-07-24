import { createGameScene, GameScene } from './render/scene';
import { Game } from './game/game';
import { PerfMeter } from './perf-meter';
import { resolveStageSelection } from './game/stages/stage-select';
import { ACCENT, SURFACE_OPAQUE, EDGE, BG, TEXT, TEXT_DIM } from './game/theme';

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
  function animate(now: number) {
    requestAnimationFrame(animate);
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    const t0 = perf.on ? performance.now() : 0;
    game.update(dt);
    const t1 = perf.on ? performance.now() : 0;
    game.sync(Math.min(dt, 0.1));
    game.render();
    const t2 = perf.on ? performance.now() : 0;
    if (perf.on) {
      perf.record(t1 - t0, t2 - t1, t2);
    }
  }
  requestAnimationFrame((now) => {
    lastTime = now;
    animate(now);
  });
}

async function main() {
  // レンダラ初期化
  const gs = await initScene();
  // ステージ決定とゲーム生成
  const stageId = await resolveStageSelection();
  const game = new Game(gs, stageId);
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
