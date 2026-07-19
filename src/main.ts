import * as THREE from 'three/webgpu';
import { createGameScene } from './render/scene';
import { Game } from './game/game';
import { STAGE1_CLEARED_KEY } from './game/const';
import { ACCENT, ACCENT_RGB, SURFACE_OPAQUE, EDGE, BG, TEXT, TEXT_DIM } from './game/theme';

// 低軌道シューティング: エントリポイント。
// 物理はメインスレッドで毎フレーム積分する(単体エンティティの中心重力
// RK4 は十分軽い)。src/physics/nbody/physics.worker.ts の N体ワーカーは
// 将来のシスルナ(太陽-地球-月)フェーズ用に残してあり、現在は未使用。
// ステージ選択画面。第二ステージは第一ステージクリア(localStorage)で解放。
function selectStage(): Promise<number> {
  return new Promise((resolve) => {
    let unlocked = false;
    try {
      unlocked = localStorage.getItem(STAGE1_CLEARED_KEY) === '1';
    } catch {
      /* localStorage 不可の環境ではステージ1のみ */
    }
    // ダークテーマ(HUD と同じ: モノトーン + 彩度の高いオレンジ)
    const SURFACE = SURFACE_OPAQUE;
    const div = document.createElement('div');
    div.style.cssText =
      'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      `gap:18px;color:${TEXT};background:${BG};font-family:Consolas,monospace;z-index:100;text-align:center`;
    const btn = (label: string, sub: string, enabled: boolean) => {
      const b = document.createElement('div');
      b.style.cssText =
        `min-width:min(420px, 88vw);max-width:92vw;padding:16px 24px;background:${SURFACE};` +
        `border:1px solid ${enabled ? `rgba(${ACCENT_RGB}, 0.4)` : EDGE};border-radius:4px;` +
        `line-height:1.7;${enabled ? 'cursor:pointer' : 'opacity:0.45'}`;
      b.innerHTML = `<div style="font-size:17px;letter-spacing:3px;color:${enabled ? ACCENT : TEXT_DIM}">${label}</div><div style="font-size:12px;color:${TEXT_DIM}">${sub}</div>`;
      return b;
    };
    div.innerHTML =
      `<div style="font-size:26px;letter-spacing:8px;margin-bottom:8px;color:${ACCENT}">DIVE INTO TEPUI</div>` +
      '<div style="font-size:12px;color:#7d838c;margin-bottom:12px">ステージを選択 ([0] / [1] / [2] キーまたはクリック)</div>';
    const b00 = btn(
      '[0] 無限耐久サバイバル (Stage 00)',
      '常時選択可。弾薬を拾ってから始まる無限の波状攻撃。自機が破壊されるまで続く',
      true,
    );
    const b0 = btn(
      '[T] 訓練ステージ — 近接戦闘訓練 (Stage 0)',
      '常時選択可。5km以内に色分けされた敵集団 約50機、制限時間2分の撃墜数スコアアタック',
      true,
    );
    const b1 = btn('[1] 第一ステージ — LEO 戦域', '高度420kmの低軌道。敵5機はすべて近傍軌道に分布', true);
    const b2 = btn(
      '[2] 第二ステージ — モルニヤ戦域',
      unlocked
        ? '敵は高楕円(モルニヤ級)軌道にも分布。軌道計画モード [M] での遷移が必須'
        : '🔒 第一ステージをクリアすると解放',
      unlocked,
    );
    div.appendChild(b00);
    div.appendChild(b0);
    div.appendChild(b1);
    div.appendChild(b2);
    document.body.appendChild(div);

    const done = (stage: number) => {
      window.removeEventListener('keydown', onKey);
      div.remove();
      resolve(stage);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Digit0') done(-1); // 0 key = Stage 00
      if (e.code === 'KeyT') done(0);    // T key = Stage 0
      if (e.code === 'Digit1' || e.code === 'Enter') done(1);
      if (e.code === 'Digit2' && unlocked) done(2);
    };
    window.addEventListener('keydown', onKey);
    b00.addEventListener('click', () => done(-1));
    b0.addEventListener('click', () => done(0));
    b1.addEventListener('click', () => done(1));
    if (unlocked) b2.addEventListener('click', () => done(2));
  });
}

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

async function main() {
  hideLoading = showLoading();
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);

  const gs = await createGameScene(canvas);
  hideLoading();
  hideLoading = null;
  const { scene, renderer } = gs;
  // ?stage=0|1|2 で選択画面をスキップ(デバッグ・共有リンク用)。
  // パラメータ未指定時は get() が null を返すので、Number(null)=0 とは
  // 区別してステージ0への誤フォースを避ける。
  const stageParam = new URLSearchParams(location.search).get('stage');
  const forced = stageParam !== null ? Number(stageParam) : NaN;
  const stage = forced === 0 || forced === 1 || forced === 2 ? forced : await selectStage();
  const game = new Game(gs, stage);

  const pipCrosshair = document.createElement('div');
  pipCrosshair.id = 'pip-crosshair';
  pipCrosshair.style.position = 'fixed';
  pipCrosshair.style.pointerEvents = 'none';
  pipCrosshair.style.color = ACCENT;
  pipCrosshair.style.fontSize = '24px';
  pipCrosshair.style.fontFamily = 'sans-serif';
  pipCrosshair.innerText = '+';
  pipCrosshair.style.transform = 'translate(-50%, -50%)';
  pipCrosshair.style.zIndex = '1000';
  pipCrosshair.style.display = 'none';
  document.body.appendChild(pipCrosshair);

  const fwdVec = new THREE.Vector3();
  const upVec = new THREE.Vector3();
  const targetVec = new THREE.Vector3();

  // ?perf=1: 軽量化計測用のフレームタイム表示(sim/render CPU時間・FPS・エンティティ数)。
  // 0.5秒ごとに集計値を更新するだけで、ゲームの挙動には影響しない。
  const perfOn = new URLSearchParams(location.search).get('perf') === '1';
  let perfEl: HTMLDivElement | null = null;
  let perfSimMs = 0;
  let perfRenderMs = 0;
  let perfFrames = 0;
  let perfLastFlush = performance.now();
  if (perfOn) {
    perfEl = document.createElement('div');
    perfEl.style.cssText =
      `position:fixed;left:8px;top:8px;z-index:2000;pointer-events:none;` +
      `font:11px Consolas,monospace;color:${TEXT};background:rgba(0,0,0,0.55);` +
      `border:1px solid ${EDGE};border-radius:3px;padding:4px 8px;white-space:pre;line-height:1.5`;
    document.body.appendChild(perfEl);
  }
  function perfFlush(now: number) {
    if (!perfEl || now - perfLastFlush < 500) return;
    const n = Math.max(1, perfFrames);
    const c = game.perfCounts();
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    perfEl.textContent =
      `fps ${((n * 1000) / (now - perfLastFlush)).toFixed(0)}  ` +
      `sim ${(perfSimMs / n).toFixed(2)}ms  render ${(perfRenderMs / n).toFixed(2)}ms\n` +
      `enemies ${c.enemies}  bullets ${c.bullets}  casings ${c.casings}  debris ${c.debris}` +
      (mem ? `\nheap ${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB` : '');
    perfSimMs = 0;
    perfRenderMs = 0;
    perfFrames = 0;
    perfLastFlush = now;
  }

  let lastTime = performance.now();
  function animate(now: number) {
    requestAnimationFrame(animate);
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    const t0 = perfOn ? performance.now() : 0;
    game.update(dt);
    const t1 = perfOn ? performance.now() : 0;
    // 戦闘ビュー / 軌道計画ビューでカメラを切り替える
    if (game.isFiring && !game.isMapMode) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      
      renderer.autoClear = false;
      renderer.clear();
      
      // Main view
      renderer.setViewport(0, 0, w, h);
      renderer.setScissor(0, 0, w, h);
      renderer.setScissorTest(true);
      renderer.render(scene, game.activeCamera);
      
      // PiP Zoom view in the upper right
      const pipSize = Math.min(w, h) * 0.35; // 画面サイズの35%
      const pipW = pipSize * 1.5;
      const pipH = pipSize;
      const padding = 20;
      const pipX = w - pipW - padding;
      const pipY = padding; // WebGPUは左上が原点なので padding が上端になる
      
      const originalFov = game.activeCamera.fov;
      const originalAspect = game.activeCamera.aspect;
      const originalPos = game.activeCamera.position.clone();
      const originalQuat = game.activeCamera.quaternion.clone();

      fwdVec.set(0, 0, 1).applyQuaternion(game.playerShipObj.quaternion);
      upVec.set(0, 1, 0).applyQuaternion(game.playerShipObj.quaternion);
      targetVec.copy(game.playerShipObj.position).add(fwdVec);

      game.activeCamera.position.copy(game.playerShipObj.position);
      game.activeCamera.up.copy(upVec);
      game.activeCamera.lookAt(targetVec);

      game.activeCamera.fov = 6; // C.ZOOM_FOV
      game.activeCamera.aspect = pipW / pipH;
      game.activeCamera.updateProjectionMatrix();
      
      game.playerShipObj.visible = false; // ズームウィンドウでは自機を非表示
      game.setFlashesVisible(false); // ズームウィンドウではマズルフラッシュも非表示

      renderer.setViewport(pipX, pipY, pipW, pipH);
      renderer.setScissor(pipX, pipY, pipW, pipH);
      renderer.render(scene, game.activeCamera);

      game.playerShipObj.visible = true; // 戻す
      game.setFlashesVisible(true);

      // PIP のターゲット菱形枠・LEAD マーカー。カメラをまだ PIP 用の位置・姿勢に
      // 据えたまま(復元前)呼ぶことで、project() 相当の計算を PIP の矩形にマップできる。
      game.updatePipOverlay({ x: pipX, y: pipY, w: pipW, h: pipH });

      // Restore
      game.activeCamera.position.copy(originalPos);
      game.activeCamera.quaternion.copy(originalQuat);
      game.activeCamera.fov = originalFov;
      game.activeCamera.aspect = originalAspect;
      game.activeCamera.updateProjectionMatrix();
      renderer.setViewport(0, 0, w, h);
      renderer.setScissorTest(false);
      renderer.autoClear = true;
      
      pipCrosshair.style.display = 'block';
      pipCrosshair.style.left = (pipX + pipW / 2) + 'px';
      pipCrosshair.style.top = (pipY + pipH / 2) + 'px';
    } else {
      pipCrosshair.style.display = 'none';
      game.updatePipOverlay(null);
      renderer.render(scene, game.activeCamera);
    }
    if (perfOn) {
      const t2 = performance.now();
      perfSimMs += t1 - t0;
      perfRenderMs += t2 - t1;
      perfFrames++;
      perfFlush(t2);
    }
  }
  requestAnimationFrame((now) => {
    lastTime = now;
    animate(now);
  });
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
