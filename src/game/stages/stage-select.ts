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
    div.innerHTML =
      '<div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:2px;width:32px;height:32px;margin-bottom:8px;">' +
      `<div style="background:${ACCENT};grid-column:span 2;grid-row:span 2"></div><div style="background:${TEXT}"></div><div style="background:${TEXT}"></div>` +
      `<div style="background:${TEXT}"></div><div style="background:${ACCENT}"></div>` +
      `<div style="background:${TEXT}"></div><div style="background:${ACCENT};grid-column:span 2"></div><div style="background:${TEXT}"></div>` +
      `<div style="background:${ACCENT}"></div><div style="background:${TEXT}"></div><div style="background:${TEXT};grid-column:span 2"></div>` +
      '</div>' +
      `<div style="font-size:26px;letter-spacing:8px;margin-bottom:8px;color:${ACCENT}">DIVE INTO TEPUI</div>` +
      '<div style="font-size:12px;color:#7d838c;margin-bottom:12px">ステージを選択 (キーまたはクリック)</div>';
    // 解放状況ごとにボタンを並べる
    const enabledByStage = new Map(STAGE_DEFINITIONS.map((stage) => [stage.id, unlockManager.isUnlocked(stage.id)]));
    for (const stage of STAGE_DEFINITIONS) {
      const enabled = enabledByStage.get(stage.id) ?? false;
      const sub = enabled ? stage.selectSub : stage.selectLockedSub ?? stage.selectSub;
      const button = btn(stage.selectLabel, sub, enabled);
      div.appendChild(button);
      if (enabled) button.addEventListener('click', () => done(stage.id));
    }
    document.body.appendChild(div);

    // 選択確定: 画面を片付けて Promise を解決する
    const done = (stage: StageId) => {
      window.removeEventListener('keydown', onKey);
      div.remove();
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
