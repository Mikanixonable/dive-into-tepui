import { createGameScene } from './render/scene';
import { Game } from './game/game';

// 低軌道シューティング: エントリポイント。
// 物理はメインスレッドで毎フレーム積分する(単体エンティティの中心重力
// RK4 は十分軽い)。src/physics/physics.worker.ts の N体ワーカーは
// 将来のシスルナ(太陽-地球-月)フェーズ用に残してあり、現在は未使用。
async function main() {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);

  const gs = await createGameScene(canvas);
  const { scene, camera, renderer } = gs;
  const game = new Game(gs);

  let lastTime = performance.now();
  function animate(now: number) {
    requestAnimationFrame(animate);
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    game.update(dt);
    renderer.render(scene, camera);
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
    'color:#9fd8e8;background:#04080c;font-family:monospace;font-size:16px;text-align:center;line-height:2';
  div.innerHTML =
    'WebGPU の初期化に失敗しました。<br>' +
    'Chrome / Edge 最新版など WebGPU 対応ブラウザでアクセスしてください。<br>' +
    `<span style="color:#58899a;font-size:12px">${String(err)}</span>`;
  document.body.appendChild(div);
});
