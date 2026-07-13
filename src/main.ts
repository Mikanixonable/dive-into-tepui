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
    const SURFACE = 'rgba(234, 237, 242, 0.96)';
    const SHADOW_LIGHT = 'rgba(255, 255, 255, 0.85)';
    const SHADOW_DARK = 'rgba(163, 177, 198, 0.55)';
    const ACCENT = '#ff7a1f';
    const ACCENT_DEEP = '#e0630f';
    const div = document.createElement('div');
    div.style.cssText =
      'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'gap:18px;color:#3d4451;background:#e4e7ec;font-family:Consolas,monospace;z-index:100;text-align:center';
    const btn = (label: string, sub: string, enabled: boolean) => {
      const b = document.createElement('div');
      b.style.cssText =
        `min-width:420px;padding:16px 24px;background:${SURFACE};border-radius:14px;` +
        `box-shadow:7px 7px 14px ${SHADOW_DARK}, -6px -6px 13px ${SHADOW_LIGHT};` +
        `line-height:1.7;${enabled ? 'cursor:pointer' : 'opacity:0.45'}`;
      b.innerHTML = `<div style="font-size:17px;letter-spacing:3px;color:${enabled ? ACCENT_DEEP : '#8891a3'}">${label}</div><div style="font-size:12px;color:#8891a3">${sub}</div>`;
      return b;
    };
    div.innerHTML =
      `<div style="font-size:26px;letter-spacing:8px;margin-bottom:8px;color:${ACCENT}">DIVE INTO TEPUI</div>` +
      '<div style="font-size:12px;color:#8891a3;margin-bottom:12px">ステージを選択 ([1] / [2] キーまたはクリック)</div>';
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
    'color:#3d4451;background:#e4e7ec;font-family:monospace;font-size:16px;text-align:center;line-height:2';
  div.innerHTML =
    '<div style="background:rgba(234,237,242,0.96);border-radius:16px;padding:22px 32px;' +
    'box-shadow:8px 8px 16px rgba(163,177,198,0.55), -7px -7px 15px rgba(255,255,255,0.85)">' +
    '<span style="color:#e0630f">WebGPU の初期化に失敗しました。</span><br>' +
    'Chrome / Edge 最新版など WebGPU 対応ブラウザでアクセスしてください。<br>' +
    `<span style="color:#8891a3;font-size:12px">${String(err)}</span></div>`;
  document.body.appendChild(div);
});
