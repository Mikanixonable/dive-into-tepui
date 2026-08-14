// 起動時のステージ選択画面 GUI。
// DEVELOP/UI_DESIGN_REFERENCE_V6.md の Rich title window を起動導線へ適用する。
import { STAGE_CLASSES } from './stages/stage-dictionary';
import { UnlockManager } from './unlock-manager';
import type { StageClass } from './stages/stage';
import { StageDebug } from './stages/stage-debug';
import { TabBar } from './hud/widgets';
import { MQ_COMPACT } from './hud/breakpoints';
import { createTitleScene, type TitleScene } from '../render/title-scene';
import tepuiRmqrUrl from '../assets/tepui-rmqr.svg';

const PAGE = '#08090d';
const SURFACE_0 = '#08090c';
const SURFACE_1 = '#0e1014';
const SURFACE_2 = '#15171c';
const TITLE_INK = '#eeeaf5';
const BODY_INK = '#c3bec9';
const MUTED_INK = '#89838f';
const FAINT_INK = '#5f5a65';
// V6 preset: Fluorescent red / blue。
const ACCENT = '#ff3155';
const NEAR_ACCENT = '#ff6b82';
const SECONDARY_ACCENT = '#3478ff';

// V6 §3 の voice 別書体。Web font が使えない環境でも role ごとのフォールバックを保つ。
const FONT_SANS = '"Arimo","Zen Kaku Gothic Antique","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif';
const FONT_SERIF = '"Cormorant Garamond","Zen Old Mincho","Hiragino Mincho ProN","Yu Mincho",serif';
const FONT_MONO = '"IBM Plex Mono","Zen Kaku Gothic Antique","Hiragino Kaku Gothic ProN","Yu Gothic",monospace';
const FONT_CANTONESE = '"Noto Serif HK","Source Han Serif HC","Songti TC",serif';

const RADIUS_WINDOW = '30px';
const RADIUS_CONTROL = '11px';

const STYLE = `
#stage-select {
  position: fixed; inset: 0; z-index: 100; overflow: auto;
  background:
    radial-gradient(circle at 10% 16%, rgb(255 49 85 / 6%), transparent 28rem),
    radial-gradient(circle at 88% 58%, rgb(52 120 255 / 5%), transparent 32rem), ${PAGE};
  color: ${BODY_INK}; font-family: ${FONT_SANS}; -webkit-font-smoothing: antialiased;
}
#stage-select .ss-shell {
  width: min(calc(100% - 24px), 1160px); min-height: 100%; margin-inline: auto;
  display: grid; place-items: center; padding-block: 18px;
}
#stage-select .ss-layout {
  width: 100%; display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(320px, 0.75fr);
  gap: 12px; align-items: stretch;
}
#stage-select .ss-3d-window {
  position: relative; width: 100%; height: min(680px, calc(100dvh - 36px)); min-height: 560px;
  overflow: hidden; isolation: isolate; border-radius: ${RADIUS_WINDOW}; background: ${SURFACE_0};
  box-shadow: 0 24px 70px rgb(0 0 0 / 38%);
}
#stage-select .ss-scene {
  position: absolute; inset: 0; z-index: 0; background: ${SURFACE_0};
}
#stage-select .ss-canvas { display: block; width: 100%; height: 100%; }
#stage-select .ss-vignette {
  position: absolute; inset: 0; pointer-events: none;
  background:
    linear-gradient(90deg, rgb(4 5 7 / 0.28), transparent 72%),
    linear-gradient(0deg, rgb(4 5 7 / 0.36), transparent 54%),
    radial-gradient(circle at 64% 42%, transparent 0 32%, rgb(4 5 7 / 0.24) 100%);
}
#stage-select .ss-hero {
  position: absolute; z-index: 2; inset: auto 28px 28px; max-width: 720px; min-width: 0;
}
#stage-select .ss-eyebrow {
  display: flex; align-items: center; gap: 10px; margin: 0 0 14px;
  color: ${ACCENT}; font-family: ${FONT_MONO};
  font-size: 10px; font-weight: 500; letter-spacing: 0.08em;
}
#stage-select .ss-eyebrow::before {
  content: ""; width: 28px; height: 2px; border-radius: 99px; background: ${ACCENT};
}
#stage-select .ss-logotype {
  margin: 0; max-width: 720px; color: ${TITLE_INK}; font-weight: 400;
  font-size: clamp(48px, 8vw, 104px); letter-spacing: -0.07em; line-height: 0.82;
}
#stage-select .ss-line { position: relative; display: block; width: fit-content; white-space: nowrap; }
#stage-select .ss-line:nth-child(2) { margin-left: 0.38em; color: ${NEAR_ACCENT}; }
#stage-select .ss-line:nth-child(3) { margin-left: 0.76em; }
#stage-select .ss-orn {
  position: absolute; left: calc(100% + 10px); color: ${SECONDARY_ACCENT};
  font-family: ${FONT_MONO}; font-size: clamp(9px, 0.95vw, 12px);
  font-weight: 500; letter-spacing: 0.08em; line-height: 1;
}
#stage-select .ss-line:nth-child(1) .ss-orn { top: 0.02em; }
#stage-select .ss-line:nth-child(2) .ss-orn { bottom: 0.04em; }
#stage-select .ss-line:nth-child(3) .ss-orn { top: 0.02em; }
#stage-select .ss-sub {
  width: fit-content; margin: clamp(16px, 2.4vw, 26px) 0 0 0.12em;
  color: ${ACCENT}; font-family: ${FONT_SERIF};
  font-size: clamp(20px, 2.4vw, 32px); font-weight: 300; line-height: 1;
}
#stage-select .ss-languages { display: flex; align-items: baseline; gap: 16px; margin: 12px 0 0 0.2em; }
#stage-select .ss-cantonese {
  margin: 0; color: ${NEAR_ACCENT}; font-family: ${FONT_CANTONESE};
  font-size: clamp(32px, 4.2vw, 56px); font-weight: 700; line-height: 1; letter-spacing: 0.04em;
}
#stage-select .ss-french {
  margin: 0; color: ${BODY_INK}; font-family: ${FONT_SANS};
  font-size: clamp(13px, 1.4vw, 17px); font-weight: 500; line-height: 1.3;
}
#stage-select .ss-window {
  min-height: 0; height: min(680px, calc(100dvh - 36px)); box-sizing: border-box;
  display: flex; flex-direction: column; gap: 14px;
  padding: 18px;
  background: ${SURFACE_1}; border-radius: ${RADIUS_WINDOW};
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.28);
  overflow: hidden;
}
#stage-select .ss-window-title {
  margin: 0 0 2px 8px; color: ${MUTED_INK};
  font-size: 15px; font-weight: 600; letter-spacing: 0.04em;
}
#stage-select .w-tabs { gap: 6px; }
#stage-select .w-tabs .w-btn {
  flex: 1; min-height: 40px; padding: 8px 16px;
  border: 0; border-radius: ${RADIUS_CONTROL};
  background: ${SURFACE_2}; color: ${MUTED_INK};
  font-family: ${FONT_SANS}; font-size: 13px; font-weight: 600; letter-spacing: 0.04em;
}
#stage-select .w-tabs .w-btn:hover { background: rgb(36 40 48 / 0.8); color: ${TITLE_INK}; }
#stage-select .w-tabs .w-btn.on { background: ${ACCENT}; color: ${PAGE}; }
#stage-select .ss-list {
  min-height: 0; flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px;
  padding: 2px 0;
}
#stage-select .ss-stage {
  box-sizing: border-box; min-height: 44px; padding: 14px 20px;
  border-radius: ${RADIUS_CONTROL};
  background: rgb(21 23 28 / 0.82); cursor: pointer; text-align: left;
  transition: background 0.15s ease;
}
#stage-select .ss-stage:hover { background: rgb(36 40 48 / 0.78); }
#stage-select .ss-stage.locked { opacity: 0.45; cursor: default; }
#stage-select .ss-stage.locked:hover { background: rgb(24 27 33 / 0.62); }
#stage-select .ss-stage-label {
  display: flex; align-items: baseline; gap: 10px;
  color: ${TITLE_INK}; font-size: 19px; letter-spacing: 0.04em; line-height: 1.4;
}
#stage-select .ss-stage:not(.locked):hover .ss-stage-label { color: ${NEAR_ACCENT}; }
#stage-select .ss-stage.locked .ss-stage-label { color: ${FAINT_INK}; }
#stage-select .ss-stage-key { font-family: ${FONT_MONO}; font-size: 11px; font-weight: 500; color: ${MUTED_INK}; }
#stage-select .ss-stage-sub { margin-top: 3px; color: ${MUTED_INK}; font-size: 12px; line-height: 1.55; }
#stage-select .ss-corner {
  position: absolute; right: clamp(26px, 3.4vw, 48px); bottom: clamp(24px, 3vh, 42px);
  width: clamp(120px, 13vw, 180px); opacity: 0.72; image-rendering: pixelated;
}
#stage-select .ss-debug {
  flex: 0 0 auto; padding-top: 12px; color: ${FAINT_INK};
  font-family: ${FONT_MONO}; font-size: 11px; cursor: pointer;
}
@media ${MQ_COMPACT} {
  #stage-select .ss-shell { place-items: start center; padding-block: 12px; }
  #stage-select .ss-layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  #stage-select .ss-3d-window,
  #stage-select .ss-window { height: auto; min-height: 460px; border-radius: 24px; }
  #stage-select .ss-hero { inset: auto 20px 22px; }
  #stage-select .ss-window {
    min-height: 0; max-height: none; padding: 16px;
  }
  #stage-select .ss-languages { flex-direction: column; gap: 7px; }
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

// V6 のタイトル専用書体を読み込む。失敗時も各 role の OS fallback でレイアウトを保つ。
function ensureTitleFonts(): void {
  if (document.getElementById('stage-select-fonts')) return;
  const link = document.createElement('link');
  link.id = 'stage-select-fonts';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Arimo:wght@400;500;600&family=Cormorant+Garamond:wght@300;400&family=IBM+Plex+Mono:wght@500&family=Noto+Serif+HK:wght@700&family=Zen+Kaku+Gothic+Antique:wght@400;500;600&family=Zen+Old+Mincho:wght@400&display=swap';
  document.head.appendChild(link);
}

// 起動選択画面(各ステージの selectGroup ごとのタブ)を表示し、選ばれたステージクラスで解決される Promise を返す。
export function selectStage(unlockManager: UnlockManager): Promise<StageClass> {
  return new Promise((resolve) => {
    ensureStyle();
    ensureTitleFonts();
    const root = document.createElement('div');
    root.id = 'stage-select';
    root.innerHTML =
      '<div class="ss-shell"><div class="ss-layout">' +
      '<section class="ss-3d-window" aria-labelledby="ss-title">' +
      '<div class="ss-scene" aria-hidden="true">' +
      '<canvas class="ss-canvas"></canvas>' +
      '<div class="ss-vignette"></div>' +
      '</div>' +
      '<div class="ss-hero">' +
      '<p class="ss-eyebrow">Sortie select · 公暦20115年</p>' +
      '<h1 id="ss-title" class="ss-logotype">' +
      '<span class="ss-line">DIVE<sup class="ss-orn">∴03</sup></span>' +
      '<span class="ss-line">INTO<sub class="ss-orn">ECI₀</sub></span>' +
      '<span class="ss-line">TEPUI<sup class="ss-orn">Ω⁺</sup></span>' +
      '</h1>' +
      '<p class="ss-sub">The Orbit Is the Battlefield</p>' +
      '<div class="ss-languages">' +
      '<p class="ss-cantonese" lang="zh-HK">前往高空堡壘的作戰</p>' +
      '<p class="ss-french" lang="fr">Opération vers la forteresse de haute altitude</p>' +
      '</div>' +
      '</div>' +
      `<img class="ss-corner" src="${tepuiRmqrUrl}" alt="Dive into Tepui">` +
      '</section>' +
      '<section class="ss-window" aria-labelledby="ss-stage-heading"></section>' +
      '</div></div>';

    // 3D角丸ウィンドウと並列する、独立したステージ選択ウィンドウ。
    const windowDiv = root.querySelector('.ss-window') as HTMLElement;
    windowDiv.innerHTML = '<h2 id="ss-stage-heading" class="ss-window-title">ステージ選択</h2>';

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
    windowDiv.appendChild(debugLink);

    document.body.appendChild(root);

    // 3D 場面は非同期に立ち上がる。選択が先に済んだ場合はでき次第そのまま破棄する。
    let scene: TitleScene | null = null;
    let selected = false;
    createTitleScene(
      root.querySelector('.ss-canvas') as HTMLCanvasElement,
      root.querySelector('.ss-3d-window') as HTMLElement,
    )
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
