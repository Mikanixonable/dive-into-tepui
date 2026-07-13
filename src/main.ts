import { createGameScene } from './render/scene';
import { Game } from './game/game';
import { STAGE1_CLEARED_KEY } from './game/const';

// 低軌道シューティング: エントリポイント。
// 物理はメインスレッドで毎フレーム積分する(単体エンティティの中心重力
// RK4 は十分軽い)。src/physics/physics.worker.ts の N体ワーカーは
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
    const SURFACE = 'rgba(13, 15, 18, 0.92)';
    const EDGE = 'rgba(255, 255, 255, 0.09)';
    const ACCENT = '#ff6a00';
    const div = document.createElement('div');
    div.style.cssText =
      'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'gap:18px;color:#e6e8eb;background:#08090c;font-family:Consolas,monospace;z-index:100;text-align:center';
    const btn = (label: string, sub: string, enabled: boolean) => {
      const b = document.createElement('div');
      b.style.cssText =
        `min-width:420px;padding:16px 24px;background:${SURFACE};` +
        `border:1px solid ${enabled ? 'rgba(255,106,0,0.4)' : EDGE};border-radius:4px;` +
        `line-height:1.7;${enabled ? 'cursor:pointer' : 'opacity:0.45'}`;
      b.innerHTML = `<div style="font-size:17px;letter-spacing:3px;color:${enabled ? ACCENT : '#7d838c'}">${label}</div><div style="font-size:12px;color:#7d838c">${sub}</div>`;
      return b;
    };
    div.innerHTML =
      `<div style="font-size:26px;letter-spacing:8px;margin-bottom:8px;color:${ACCENT}">DIVE INTO TEPUI</div>` +
      '<div style="font-size:12px;color:#7d838c;margin-bottom:12px">ステージを選択 ([1] / [2] キーまたはクリック)</div>';
    const b1 = btn('[1] 第一ステージ — LEO 戦域', '高度420kmの低軌道。敵5機はすべて近傍軌道に分布', true);
    const b2 = btn(
      '[2] 第二ステージ — モルニヤ戦域',
      unlocked
        ? '敵は高楕円(モルニヤ級)軌道にも分布。軌道計画モード [M] での遷移が必須'
        : '🔒 第一ステージをクリアすると解放',
      unlocked,
    );
    div.appendChild(b1);
    div.appendChild(b2);
    document.body.appendChild(div);

    const done = (stage: number) => {
      window.removeEventListener('keydown', onKey);
      div.remove();
      resolve(stage);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Digit1' || e.code === 'Enter') done(1);
      if (e.code === 'Digit2' && unlocked) done(2);
    };
    window.addEventListener('keydown', onKey);
    b1.addEventListener('click', () => done(1));
    if (unlocked) b2.addEventListener('click', () => done(2));
  });
}

async function main() {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);

  const gs = await createGameScene(canvas);
  const { scene, renderer } = gs;
  // ?stage=1|2 で選択画面をスキップ(デバッグ・共有リンク用)
  const forced = Number(new URLSearchParams(location.search).get('stage'));
  const stage = forced === 1 || forced === 2 ? forced : await selectStage();
  const game = new Game(gs, stage);

  let lastTime = performance.now();
  function animate(now: number) {
    requestAnimationFrame(animate);
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    game.update(dt);
    // 戦闘ビュー / 軌道計画ビューでカメラを切り替える
    renderer.render(scene, game.activeCamera);
  }
  requestAnimationFrame((now) => {
    lastTime = now;
    animate(now);
  });
}

main().catch((err) => {
  console.error(err);
  const div = document.createElement('div');
  div.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#e6e8eb;background:#08090c;font-family:monospace;font-size:16px;text-align:center;line-height:2';
  div.innerHTML =
    '<div style="background:rgba(13,15,18,0.92);border:1px solid rgba(255,255,255,0.09);border-radius:4px;padding:22px 32px">' +
    '<span style="color:#ff6a00">WebGPU の初期化に失敗しました。</span><br>' +
    'Chrome / Edge 最新版など WebGPU 対応ブラウザでアクセスしてください。<br>' +
    `<span style="color:#7d838c;font-size:12px">${String(err)}</span></div>`;
  document.body.appendChild(div);
});
