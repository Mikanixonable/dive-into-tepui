// 起動時のステージ選択画面 GUI。
// デザインは DEVELOP/TYPOGRAPHY_LOGOTYPE_SYMBOL_PROPOSAL_V3.md(第三版)の表示場面規則
// (Scene first / 単一アクセント / 変則改行ロゴタイプ / 外周線なしの境界 / 角丸とピル)に従い、
// 背景の 3D 場面は第五版(DEVELOP/UI_DESIGN_REFERENCE_V5.md §7)の光沢プラスチック造形を使う。
// 配色・書体は第三版標本自身の値であり、theme.ts への統合は移行計画 Phase 1 の仕事。
import { STAGE_CLASSES } from './stages/stage-dictionary';
import { UnlockManager } from './unlock-manager';
import type { StageClass } from './stages/stage';
import { StageDebug } from './stages/stage-debug';
import { TabBar } from './hud/widgets';
import { MQ_COMPACT } from './hud/breakpoints';
import { createTitleScene, type TitleScene } from '../render/title-scene';
import tepuiRmqrUrl from '../assets/tepui-rmqr.svg';

// 第三版標本のダーク面パレット(§7.1)とアクセント hsl(12 100% 56%) = #FF4B1F。
const PAGE = '#07080a';
const TITLE_INK = '#eeeaf5';
const MUTED_INK = '#89838f';
const FAINT_INK = '#5f5a65';
const ACCENT_V3 = '#ff4b1f';

// 第三版の書体スタック(§3)。WOFF2 自己配信前はローカルフォールバックで成立させる。
const FONT_SANS = '"Arimo","Zen Kaku Gothic Antique","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif';
const FONT_SERIF = '"Cormorant Garamond","Zen Old Mincho","Hiragino Mincho ProN","Yu Mincho",serif';
const FONT_MONO = '"IBM Plex Mono","Zen Kaku Gothic Antique","Hiragino Kaku Gothic ProN","Yu Gothic",monospace';

// 第三版 §9.1 の角丸段。Feature=48 が 3D 表示部、Window=34 がグラス面、Card=22 が行、Pill がタブ。
const RADIUS_FEATURE = '48px';
const RADIUS_WINDOW = '34px';
const RADIUS_CARD = '22px';
const RADIUS_PILL = '999px';

const STYLE = `
#stage-select {
  position: fixed; inset: 0; z-index: 100; overflow: hidden; isolation: isolate;
  background: ${PAGE}; color: ${TITLE_INK}; font-family: ${FONT_SANS};
}
#stage-select .ss-scene {
  position: absolute; inset: clamp(14px, 2.2vw, 32px); z-index: -2;
  border-radius: ${RADIUS_FEATURE}; overflow: hidden; background: #08090b;
  box-shadow: 0 24px 80px rgb(0 0 0 / 0.55);
}
#stage-select .ss-canvas { display: block; width: 100%; height: 100%; }
#stage-select .ss-vignette {
  position: absolute; inset: 0; pointer-events: none;
  background:
    linear-gradient(90deg, rgb(7 8 10 / 0.42), transparent 62%),
    linear-gradient(0deg, rgb(7 8 10 / 0.72), transparent 40%),
    radial-gradient(circle at 42% 44%, transparent 34%, rgb(7 8 10 / 0.4) 100%);
}
#stage-select .ss-grid {
  position: relative; height: 100%; box-sizing: border-box;
  display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(300px, 430px);
  gap: clamp(20px, 4vw, 64px); align-items: center;
  padding: clamp(28px, 6vh, 68px) clamp(30px, 5vw, 76px);
  padding: clamp(28px, 6dvh, 68px) clamp(30px, 5vw, 76px);
}
#stage-select .ss-hero { min-width: 0; }
#stage-select .ss-eyebrow {
  display: flex; align-items: center; gap: 10px; margin: 0 0 14px;
  color: ${MUTED_INK}; font-family: ${FONT_MONO};
  font-size: 11px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase;
}
#stage-select .ss-eyebrow::before {
  content: ""; width: 28px; height: 3px; border-radius: ${RADIUS_PILL}; background: ${ACCENT_V3};
}
#stage-select .ss-logotype {
  margin: 0; color: #fff; font-weight: 400;
  font-size: clamp(34px, 6.3vw, 90px);
  letter-spacing: -0.065em; line-height: 0.92; text-transform: uppercase;
  mix-blend-mode: difference;
}
#stage-select .ss-line { position: relative; display: block; width: fit-content; white-space: nowrap; }
#stage-select .ss-line:nth-child(2) { margin-left: 0.42em; }
#stage-select .ss-line:nth-child(3) { margin-left: 0.84em; }
#stage-select .ss-orn {
  position: absolute; left: calc(100% + 10px); color: #fff;
  font-family: ${FONT_MONO}; font-size: clamp(9px, 0.95vw, 12px);
  font-weight: 500; letter-spacing: 0.08em; line-height: 1;
}
#stage-select .ss-line:nth-child(1) .ss-orn { top: 0.02em; }
#stage-select .ss-line:nth-child(2) .ss-orn { bottom: 0.04em; }
#stage-select .ss-line:nth-child(3) .ss-orn { top: 0.02em; }
#stage-select .ss-sub {
  width: fit-content; margin: clamp(16px, 2.4vw, 26px) 0 0 0.12em;
  color: ${ACCENT_V3}; font-family: ${FONT_SERIF};
  font-size: clamp(20px, 2.4vw, 32px); font-weight: 300; line-height: 1;
  mix-blend-mode: difference;
}
#stage-select .ss-sub-ja {
  width: fit-content; margin: 6px 0 0 0.22em;
  color: ${ACCENT_V3}; font-family: ${FONT_SERIF};
  font-size: clamp(14px, 1.3vw, 18px); font-weight: 400; line-height: 1.3;
  mix-blend-mode: difference;
}
#stage-select .ss-window {
  min-height: 0; max-height: 100%; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 14px;
  padding: 20px;
  background: rgb(13 15 19 / 0.58); border-radius: ${RADIUS_WINDOW};
  box-shadow: 0 24px 80px rgb(0 0 0 / 0.3);
  backdrop-filter: blur(24px) saturate(115%);
  -webkit-backdrop-filter: blur(24px) saturate(115%);
}
#stage-select .ss-window-title {
  margin: 0 0 2px 8px; color: ${MUTED_INK};
  font-size: 15px; font-weight: 600; letter-spacing: 0.04em;
}
/* モード選択タブ: 第三版 §9.1 の Pill と §10.2 の「外周線なし・面色差」に合わせる。 */
#stage-select .w-tabs { gap: 6px; }
#stage-select .w-tabs .w-btn {
  flex: 1; min-height: 40px; padding: 8px 16px;
  border: 0; border-radius: ${RADIUS_PILL};
  background: rgb(24 27 33 / 0.72); color: ${MUTED_INK};
  font-family: ${FONT_SANS}; font-size: 13px; font-weight: 600; letter-spacing: 0.04em;
}
#stage-select .w-tabs .w-btn:hover { background: rgb(36 40 48 / 0.8); color: ${TITLE_INK}; }
#stage-select .w-tabs .w-btn.on { background: ${ACCENT_V3}; color: ${PAGE}; }
#stage-select .ss-list {
  min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px;
  padding: 2px 0;
}
#stage-select .ss-stage {
  box-sizing: border-box; min-height: 44px; padding: 14px 20px;
  border-radius: ${RADIUS_CARD};
  background: rgb(24 27 33 / 0.62); cursor: pointer; text-align: left;
  transition: background 0.15s ease;
}
#stage-select .ss-stage:hover { background: rgb(36 40 48 / 0.78); }
#stage-select .ss-stage.locked { opacity: 0.45; cursor: default; }
#stage-select .ss-stage.locked:hover { background: rgb(24 27 33 / 0.62); }
#stage-select .ss-stage-label {
  display: flex; align-items: baseline; gap: 10px;
  color: ${TITLE_INK}; font-size: 19px; letter-spacing: 0.04em; line-height: 1.4;
}
#stage-select .ss-stage:not(.locked):hover .ss-stage-label { color: ${ACCENT_V3}; }
#stage-select .ss-stage.locked .ss-stage-label { color: ${FAINT_INK}; }
#stage-select .ss-stage-key { font-family: ${FONT_MONO}; font-size: 11px; font-weight: 500; color: ${MUTED_INK}; }
#stage-select .ss-stage-sub { margin-top: 3px; color: ${MUTED_INK}; font-size: 12px; line-height: 1.55; }
#stage-select .ss-corner {
  position: absolute; right: clamp(26px, 3.4vw, 48px); bottom: clamp(24px, 3vh, 42px);
  width: clamp(120px, 13vw, 180px); opacity: 0.72; image-rendering: pixelated;
}
#stage-select .ss-debug {
  position: absolute; bottom: clamp(24px, 3vh, 42px); left: clamp(30px, 5vw, 76px);
  color: ${FAINT_INK}; font-family: ${FONT_MONO}; font-size: 11px; cursor: pointer;
}
@media ${MQ_COMPACT} {
  #stage-select { overflow-y: auto; }
  #stage-select .ss-scene { position: fixed; border-radius: ${RADIUS_WINDOW}; }
  #stage-select .ss-grid {
    grid-template-columns: minmax(0, 1fr); align-items: start; height: auto; min-height: 100%;
    gap: 24px; padding: 32px 24px 72px;
  }
  #stage-select .ss-window { max-height: none; border-radius: ${RADIUS_CARD}; padding: 16px; }
  #stage-select .ss-corner { display: none; }
}
`;

// 画面固有の CSS を一度だけ注入する。
function ensureStyle(): void {
  if (document.getElementById('stage-select-style')) return;
  const style = document.createElement('style');
  style.id = 'stage-select-style';
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// 起動選択画面(各ステージの selectGroup ごとのタブ)を表示し、選ばれたステージクラスで解決される Promise を返す。
export function selectStage(unlockManager: UnlockManager): Promise<StageClass> {
  return new Promise((resolve) => {
    ensureStyle();
    const root = document.createElement('div');
    root.id = 'stage-select';
    root.innerHTML =
      '<div class="ss-scene" aria-hidden="true">' +
      '<canvas class="ss-canvas"></canvas>' +
      '<div class="ss-vignette"></div>' +
      '</div>' +
      '<div class="ss-grid">' +
      '<div class="ss-hero">' +
      '<p class="ss-eyebrow">Sortie select · 公暦20115年</p>' +
      '<h1 class="ss-logotype">' +
      '<span class="ss-line">DIVE<sup class="ss-orn">∴03</sup></span>' +
      '<span class="ss-line">INTO<sub class="ss-orn">ECI₀</sub></span>' +
      '<span class="ss-line">TEPUI<sup class="ss-orn">Ω⁺</sup></span>' +
      '</h1>' +
      '<p class="ss-sub">The Orbit Is the Battlefield</p>' +
      '<p class="ss-sub-ja">軌道が戦場になる</p>' +
      '</div>' +
      '</div>' +
      `<img class="ss-corner" src="${tepuiRmqrUrl}" alt="dive into tepui">`;

    // グラスウィンドウ: タブとステージ一覧を 3D 場面の上に浮かべる(外周線なし)。
    const windowDiv = document.createElement('div');
    windowDiv.className = 'ss-window';
    windowDiv.innerHTML = '<h2 class="ss-window-title">ステージ選択</h2>';
    (root.querySelector('.ss-grid') as HTMLElement).appendChild(windowDiv);

    // タブは selectGroup の初出順に並べる。
    const groups: string[] = [];
    for (const stageClass of STAGE_CLASSES) {
      if (stageClass.hiddenFromSelect || groups.includes(stageClass.selectGroup)) continue;
      groups.push(stageClass.selectGroup);
    }

    const listDiv = document.createElement('div');
    listDiv.className = 'ss-list';

    // タブ切替: 選んだタブに応じて下のリスト表示を入れ替える。
    const tabBar = new TabBar<string>(groups.map((g) => [g, g] as const), (group) => setActiveTab(group));
    windowDiv.appendChild(tabBar.element);
    windowDiv.appendChild(listDiv);

    // 指定タブを選択状態にし、そのグループのステージ行を一覧へ並べ直す。
    const setActiveTab = (group: string) => {
      tabBar.setSelected(group);
      // 一覧はタブ切替のたびに作り直す(起動時の一回きりの画面なので差分更新は要らない)。
      listDiv.innerHTML = '';
      for (const stageClass of STAGE_CLASSES) {
        if (stageClass.hiddenFromSelect || stageClass.selectGroup !== group) continue;
        const enabled = enabledByStage.get(stageClass.id) ?? false;
        const sub = enabled ? stageClass.selectSub : stageClass.selectLockedSub ?? stageClass.selectSub;
        const key = stageClass.selectKeys[0] ? `[${stageClass.selectKeys[0].replace('Digit', '').replace('Key', '')}]` : '';
        const row = document.createElement('div');
        row.className = `ss-stage${enabled ? '' : ' locked'}`;
        row.innerHTML =
          `<div class="ss-stage-label"><span>${stageClass.selectLabel}</span><span class="ss-stage-key">${key}</span></div>` +
          `<div class="ss-stage-sub">${sub}</div>`;
        listDiv.appendChild(row);
        if (enabled) row.addEventListener('click', () => done(stageClass));
      }
    };

    // 解放状況ごとにボタンを並べる
    const enabledByStage = new Map(STAGE_CLASSES.map((stageClass) => [stageClass.id, unlockManager.isUnlocked(stageClass.id)]));
    if (groups[0]) setActiveTab(groups[0]);

    // 隅の控えめなリンクからデバッグステージへ移動できる。
    const debugLink = document.createElement('div');
    debugLink.className = 'ss-debug';
    debugLink.textContent = 'debug stage [d]';
    debugLink.addEventListener('click', () => done(StageDebug));
    root.appendChild(debugLink);

    document.body.appendChild(root);

    // 3D 場面は非同期に立ち上がる。選択が先に済んだ場合はでき次第そのまま破棄する。
    let scene: TitleScene | null = null;
    let selected = false;
    createTitleScene(root.querySelector('.ss-canvas') as HTMLCanvasElement, root)
      .then((s) => { scene = s; if (selected) s.dispose(); })
      .catch(() => {});

    // 選択確定: 3D 場面と画面を片付けて Promise を解決する
    const done = (stageClass: StageClass) => {
      window.removeEventListener('keydown', onKey);
      selected = true;
      scene?.dispose();
      root.remove();
      resolve(stageClass);
    };
    // 解放済みステージのショートカットキーにマッチしたら選択確定する。タブに関係なく効く。
    const onKey = (e: KeyboardEvent) => {
      for (const stageClass of STAGE_CLASSES) {
        if (!(enabledByStage.get(stageClass.id) ?? false)) continue;
        if (!stageClass.selectKeys.includes(e.code)) continue;
        done(stageClass);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
  });
}
