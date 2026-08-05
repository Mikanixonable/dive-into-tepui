// クエリパラメータでの強制指定・起動選択画面 GUI を提供する。
import { STAGE_DEFINITIONS } from './stages/stage-dictionary';
import { UnlockManager } from './unlock-manager';
import { LaunchSelection } from './game-mode';
import { ACCENT, ACCENT_RGB, SURFACE_OPAQUE, EDGE, BG, TEXT, TEXT_DIM, FONT } from './theme';
import tepuiRmqrUrl from '../assets/tepui-rmqr.svg';

// 起動選択画面(ステージモード/クリエイティブモードのタブ)を表示し、
// 選ばれた LaunchSelection で解決される Promise を返す。
export function selectLaunch(unlockManager: UnlockManager): Promise<LaunchSelection> {
  return new Promise((resolve) => {
    const SURFACE = SURFACE_OPAQUE;
    const div = document.createElement('div');
    div.style.cssText =
      'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      `gap:18px;color:${TEXT};background:${BG};font-family:${FONT};z-index:100;text-align:center`;
    // 1項目分のボタン要素を組み立てる。ロック中は薄く表示しクリック不可にする。
    const btn = (label: string, sub: string, enabled: boolean) => {
      const b = document.createElement('div');
      b.style.cssText =
        `width: 420px; max-width: 92vw; box-sizing: border-box; padding: 16px 24px; background: ${SURFACE};` +
        `border: 1px solid ${enabled ? `rgba(${ACCENT_RGB}, 0.4)` : EDGE}; border-radius: 4px;` +
        `line-height: 1.7; ${enabled ? 'cursor: pointer' : 'opacity: 0.45'}`;
      b.innerHTML = `<div style="font-size:22px;letter-spacing:3px;color:${enabled ? ACCENT : TEXT_DIM}">${label}</div><div style="font-size:12px;color:${TEXT_DIM}">${sub}</div>`;
      return b;
    };
    // rMQRとタイトル文字を同じ幅のロゴブロックにまとめる。画像だけを
    // 置くとタイトル文字が消えたように見えるため、コードの直下に常に表示する。
    div.innerHTML =
      `<div style="width:min(78vw,430px);display:flex;flex-direction:column;align-items:stretch;margin-bottom:14px">` +
      `<img src="${tepuiRmqrUrl}" alt="dive into tepui" style="display:block;width:100%;height:auto;image-rendering:pixelated">` +
      `<div style="width:100%;box-sizing:border-box;padding-top:10px;color:${ACCENT};font-size:clamp(16px,3.8vw,22px);line-height:1.2;letter-spacing:clamp(3px,0.9vw,6px);text-align:center;white-space:nowrap">Dive into Tepui</div>` +
      `</div>`;

    // タブ切替: 選んだタブに応じて下のリスト表示を入れ替える。
    const tabRow = document.createElement('div');
    tabRow.style.cssText = 'display:flex;gap:10px;margin-bottom:4px;';
    const tab = (label: string) => {
      const t = document.createElement('div');
      t.textContent = label;
      t.style.cssText =
        `padding:6px 18px;font-size:13px;letter-spacing:2px;cursor:pointer;border-radius:3px;border:1px solid ${EDGE};`;
      return t;
    };
    const stageTab = tab('ステージモード');
    const creativeTab = tab('クリエイティブモード');
    tabRow.append(stageTab, creativeTab);
    div.appendChild(tabRow);

    const listDiv = document.createElement('div');
    listDiv.style.cssText = 'display:flex;flex-direction:column;gap:18px;align-items:center;';
    div.appendChild(listDiv);

    const setActiveTab = (mode: 'stage' | 'creative') => {
      stageTab.style.color = mode === 'stage' ? ACCENT : TEXT_DIM;
      stageTab.style.borderColor = mode === 'stage' ? `rgba(${ACCENT_RGB}, 0.4)` : EDGE;
      creativeTab.style.color = mode === 'creative' ? ACCENT : TEXT_DIM;
      creativeTab.style.borderColor = mode === 'creative' ? `rgba(${ACCENT_RGB}, 0.4)` : EDGE;
      listDiv.innerHTML = '';
      if (mode === 'stage') {
        for (const stage of STAGE_DEFINITIONS) {
          if (stage.hiddenFromSelect) continue;
          const enabled = enabledByStage.get(stage.id) ?? false;
          const sub = enabled ? stage.selectSub : stage.selectLockedSub ?? stage.selectSub;
          const keyStr = stage.selectKeys[0] ? ` [${stage.selectKeys[0].replace('Digit', '').replace('Key', '')}]` : '';
          const button = btn(stage.selectLabel + keyStr, sub, enabled);
          listDiv.appendChild(button);
          if (enabled) button.addEventListener('click', () => done({ mode: 'stage', stage: stage.id }));
        }
      } else {
        const button = btn('CREATIVE', '軌道上に艦艇を自由に配置して眺める', true);
        listDiv.appendChild(button);
        button.addEventListener('click', () => done({ mode: 'creative' }));
      }
    };
    stageTab.addEventListener('click', () => setActiveTab('stage'));
    creativeTab.addEventListener('click', () => setActiveTab('creative'));

    // 解放状況ごとにボタンを並べる
    const enabledByStage = new Map(STAGE_DEFINITIONS.map((stage) => [stage.id, unlockManager.isUnlocked(stage.id)]));
    setActiveTab('stage');

    document.body.appendChild(div);

    // 隅の控えめなリンクからデバッグステージへ移動できる。
    const debugLink = document.createElement('div');
    debugLink.textContent = 'debug stage [d]';
    debugLink.style.cssText =
      `position: fixed; bottom: 10px; left: 14px; font-size: 11px; color: ${TEXT_DIM}; cursor: pointer; z-index: 200;`;
    debugLink.addEventListener('click', () => done({ mode: 'stage', stage: 'debug' }));
    document.body.appendChild(debugLink);

    // 選択確定: 画面を片付けて Promise を解決する
    const done = (selection: LaunchSelection) => {
      window.removeEventListener('keydown', onKey);
      div.remove();
      debugLink.remove();
      resolve(selection);
    };
    // 解放済みステージのショートカットキーにマッチしたら選択確定する
    const onKey = (e: KeyboardEvent) => {
      for (const stage of STAGE_DEFINITIONS) {
        if (!(enabledByStage.get(stage.id) ?? false)) continue;
        if (!stage.selectKeys.includes(e.code)) continue;
        done({ mode: 'stage', stage: stage.id });
        return;
      }
    };
    window.addEventListener('keydown', onKey);
  });
}
