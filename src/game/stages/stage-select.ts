// ステージ選択の外部化。main.ts はどのステージが選ばれたかだけを知ればよく、
// クエリパラメータでの強制指定・選択画面 GUI の実装はここに閉じる。
import { StageId } from './stage';
import { STAGE_DEFINITIONS } from './stage-dictionary';
import { UnlockManager } from '../unlock-manager';
import { ACCENT, ACCENT_RGB, SURFACE_OPAQUE, EDGE, BG, TEXT, TEXT_DIM } from '../theme';

// ステージ選択画面。解放判定・クリア記録は unlock-manager.ts の UnlockManager に委ねる。
export function selectStage(unlockManager: UnlockManager): Promise<StageId> {
  return new Promise((resolve) => {
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
      '<div style="font-size:12px;color:#7d838c;margin-bottom:12px">ステージを選択 (キーまたはクリック)</div>';
    const enabledByStage = new Map(STAGE_DEFINITIONS.map((stage) => [stage.id, unlockManager.isUnlocked(stage.id)]));
    for (const stage of STAGE_DEFINITIONS) {
      const enabled = enabledByStage.get(stage.id) ?? false;
      const sub = enabled ? stage.selectSub : stage.selectLockedSub ?? stage.selectSub;
      const button = btn(stage.selectLabel, sub, enabled);
      div.appendChild(button);
      if (enabled) button.addEventListener('click', () => done(stage.id));
    }
    document.body.appendChild(div);

    const done = (stage: StageId) => {
      window.removeEventListener('keydown', onKey);
      div.remove();
      resolve(stage);
    };
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
