// クエリパラメータでの強制指定・選択画面 GUI を提供する。
import { StageId } from './stage';
import { STAGE_DEFINITIONS } from './stage-dictionary';
import { UnlockManager } from '../unlock-manager';
import { ACCENT, ACCENT_RGB, SURFACE_OPAQUE, EDGE, BG, TEXT, TEXT_DIM, FONT } from '../theme';

// ステージ選択画面を表示し、選ばれた StageId で解決される Promise を返す。
export function selectStage(unlockManager: UnlockManager): Promise<StageId> {
  return new Promise((resolve) => {
    const SURFACE = SURFACE_OPAQUE;
    const div = document.createElement('div');
    div.style.cssText =
      'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      `gap:18px;color:${TEXT};background:${BG};font-family:${FONT};z-index:100;text-align:center`;
    // 1ステージ分のボタン要素を組み立てる。ロック中は薄く表示しクリック不可にする。
    const btn = (label: string, sub: string, enabled: boolean) => {
      const b = document.createElement('div');
      b.style.cssText =
        `width: 420px; max-width: 92vw; box-sizing: border-box; padding: 16px 24px; background: ${SURFACE};` +
        `border: 1px solid ${enabled ? `rgba(${ACCENT_RGB}, 0.4)` : EDGE}; border-radius: 4px;` +
        `line-height: 1.7; ${enabled ? 'cursor: pointer' : 'opacity: 0.45'}`;
      b.innerHTML = `<div style="font-size:22px;letter-spacing:3px;color:${enabled ? ACCENT : TEXT_DIM}">${label}</div><div style="font-size:12px;color:${TEXT_DIM}">${sub}</div>`;
      return b;
    };
    let qrHtml = '<div style="display:grid;grid-template-columns:repeat(12, 1fr);gap:1.5px;width:56px;height:56px;margin-bottom:12px;">';
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        const isTL = x < 4 && y < 4;
        const isTR = x > 7 && y < 4;
        const isBL = x < 4 && y > 7;
        let color = 'transparent';
        if (isTL || isTR || isBL) {
          const lx = isTR ? x - 8 : x;
          const ly = isBL ? y - 8 : y;
          if (lx === 0 || lx === 3 || ly === 0 || ly === 3 || (lx === 1 && ly === 1) || (lx === 2 && ly === 2)) {
             color = ACCENT;
          }
        } else {
          const hash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
          if (hash - Math.floor(hash) > 0.5) {
            color = TEXT;
          }
        }
        qrHtml += `<div style="background:${color}"></div>`;
      }
    }
    qrHtml += '</div>';

    div.innerHTML =
      qrHtml +
      `<div style="font-size:52px;letter-spacing:8px;margin-bottom:8px;color:${ACCENT}">Dive into Tepui</div>`
    // 解放状況ごとにボタンを並べる
    const enabledByStage = new Map(STAGE_DEFINITIONS.map((stage) => [stage.id, unlockManager.isUnlocked(stage.id)]));
    for (const stage of STAGE_DEFINITIONS) {
      if (stage.hiddenFromSelect) continue;
      const enabled = enabledByStage.get(stage.id) ?? false;
      const sub = enabled ? stage.selectSub : stage.selectLockedSub ?? stage.selectSub;
      const button = btn(stage.selectLabel, sub, enabled);
      div.appendChild(button);
      if (enabled) button.addEventListener('click', () => done(stage.id));
    }
    document.body.appendChild(div);

    // 隅の控えめなリンクからデバッグステージへ移動できる。
    const debugLink = document.createElement('div');
    debugLink.textContent = 'debug stage';
    debugLink.style.cssText =
      `position: fixed; bottom: 10px; left: 14px; font-size: 11px; color: ${TEXT_DIM}; cursor: pointer;`;
    debugLink.addEventListener('click', () => done('debug'));
    document.body.appendChild(debugLink);

    // 選択確定: 画面を片付けて Promise を解決する
    const done = (stage: StageId) => {
      window.removeEventListener('keydown', onKey);
      div.remove();
      debugLink.remove();
      resolve(stage);
    };
    // 解放済みステージのショートカットキーにマッチしたら選択確定する
    const onKey = (e: KeyboardEvent) => {
      for (const stage of STAGE_DEFINITIONS) {
        if (!(enabledByStage.get(stage.id) ?? false)) continue;
        if (!stage.selectKeys.includes(e.code)) continue;
        done(stage.id);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
  });
}
