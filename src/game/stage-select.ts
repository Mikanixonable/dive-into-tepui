// 起動時のステージ選択画面 GUI。
// DEVELOP/UI_DESIGN_REFERENCE_V6.md の Rich title window を起動導線へ適用する。
import { STAGE_CLASSES } from './stages/stage-dictionary';
import { UnlockManager } from './unlock-manager';
import type { StageClass } from './stages/stage';
import { StageDebug } from './stages/stage-debug';
import { TabBar } from './hud/widgets';
import { MQ_COMPACT, MQ_SHORT } from './hud/breakpoints';
import { createTitleScene, type TitleScene } from '../render/title-scene';
import tepuiRmqrUrl from '../assets/tepui-rmqr.svg';

const PAGE = '#08090d';
const SURFACE_0 = '#08090c';
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
const RADIUS_PANEL = '16px';
const RADIUS_CONTROL = '11px';

const STYLE = `
#stage-select {
  position: fixed; inset: 0; z-index: 100; height: 100dvh; overflow: hidden;
  background:
    radial-gradient(circle at 10% 16%, rgb(255 49 85 / 6%), transparent 28rem),
    radial-gradient(circle at 88% 58%, rgb(52 120 255 / 5%), transparent 32rem), ${PAGE};
  color: ${BODY_INK}; font-family: ${FONT_SANS}; -webkit-font-smoothing: antialiased;
}
#stage-select .ss-shell {
  width: min(calc(100% - 24px), 1160px); height: 100%; min-height: 0; box-sizing: border-box;
  margin-inline: auto; display: grid; place-items: center; padding-block: 18px;
}
#stage-select .ss-layout {
  width: 100%; height: min(680px, calc(100dvh - 36px)); min-height: 0;
  display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(320px, 0.75fr);
  gap: 12px; align-items: stretch;
}
#stage-select .ss-3d-window {
  position: relative; width: 100%; height: 100%; min-height: 0;
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
  margin: 0; max-width: 720px; color: ${TITLE_INK}; font-weight: 500;
  font-size: clamp(48px, 8vw, 104px); letter-spacing: -0.07em; line-height: 0.82;
  text-wrap: balance;
}
#stage-select .ss-title-main { display: block; white-space: nowrap; }
#stage-select .ss-title-near { color: ${NEAR_ACCENT}; }
#stage-select .ss-title-formula {
  display: inline-block; margin-left: 0.16em; color: ${SECONDARY_ACCENT};
  font-family: ${FONT_SERIF}; font-size: 0.35em; font-weight: 400;
  vertical-align: 0.62em; letter-spacing: 0;
}
#stage-select .ss-ornament-row {
  display: flex; align-items: center; gap: 14px; margin: 13px 0 0 0.2em;
  color: ${SECONDARY_ACCENT}; font-family: ${FONT_MONO}; font-size: 10px;
  font-weight: 500; letter-spacing: 0.12em; line-height: 1;
}
#stage-select .ss-ornament-row span:nth-child(2n) { color: ${NEAR_ACCENT}; }
#stage-select .ss-ornament-row span:nth-child(3n) { color: ${ACCENT}; }
#stage-select .ss-sub {
  width: fit-content; margin: 0 0 0 0.12em;
  color: ${ACCENT}; font-family: ${FONT_SERIF};
  font-size: clamp(14px, 1.68vw, 22px); font-weight: 300; line-height: 1.12;
}
#stage-select .ss-subrow {
  display: flex; align-items: end; justify-content: space-between; gap: 18px; margin-top: 20px;
}
#stage-select .ss-languages { display: flex; align-items: baseline; gap: 16px; margin: 12px 0 0 0.2em; }
#stage-select .ss-cantonese {
  margin: 0; color: ${NEAR_ACCENT}; font-family: ${FONT_CANTONESE};
  flex: 0 0 7em; width: 7em; font-size: clamp(29px, 3.78vw, 51px);
  font-weight: 700; line-height: 1; letter-spacing: 0.04em;
}
#stage-select .ss-french {
  margin: 0; color: ${BODY_INK}; font-family: ${FONT_SANS};
  font-size: clamp(13px, 1.4vw, 17px); font-weight: 500; line-height: 1.3;
}
#stage-select .ss-status {
  min-width: 190px; padding: 11px 13px; border-radius: ${RADIUS_PANEL};
  color: ${BODY_INK};
  background: linear-gradient(135deg, rgb(52 120 255 / 13%), rgb(255 49 85 / 6%)), rgb(8 9 13 / 28%);
  box-shadow: 0 14px 34px rgb(0 0 0 / 24%), inset 0 1px 0 rgb(255 255 255 / 14%);
  backdrop-filter: blur(28px) saturate(165%); -webkit-backdrop-filter: blur(28px) saturate(165%);
  font: 10px/1.55 ${FONT_MONO};
}
#stage-select .ss-status b { color: ${SECONDARY_ACCENT}; font-weight: 500; }
#stage-select .ss-window {
  position: relative;
  min-height: 0; height: 100%; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 14px;
  padding: 18px;
  background: rgb(19 21 26 / 68%); border-radius: ${RADIUS_WINDOW};
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.28);
  backdrop-filter: blur(26px) saturate(120%);
  -webkit-backdrop-filter: blur(26px) saturate(120%);
  overflow: hidden;
}
#stage-select .ss-stage-qr {
  position: absolute; z-index: 0; left: 18px; right: 18px; bottom: 20px; width: calc(100% - 36px);
  height: auto; opacity: 0.13; pointer-events: none; image-rendering: pixelated;
  filter: grayscale(1) contrast(1.1) brightness(1.6); mix-blend-mode: screen;
}
#stage-select .ss-window > .w-tabs,
#stage-select .ss-window > .ss-list,
#stage-select .ss-window > .ss-debug { position: relative; z-index: 1; }
#stage-select .ss-window-title {
  margin: 0 0 2px 8px; color: ${MUTED_INK};
  font-size: 15px; font-weight: 600; letter-spacing: 0.04em;
}
#stage-select .w-tabs { gap: 6px; }
#stage-select .w-tabs .w-btn {
  position: relative; flex: 1; min-height: 44px; padding: 8px 12px;
  display: inline-flex; align-items: center; justify-content: center; text-align: center;
  border: 0; border-radius: ${RADIUS_CONTROL} ${RADIUS_CONTROL} 0 0;
  background: transparent; color: ${MUTED_INK};
  font-family: ${FONT_SANS}; font-size: 13px; font-weight: 600; letter-spacing: 0.04em;
}
#stage-select .w-tabs { border-bottom: 1px solid rgb(238 234 245 / 12%); }
#stage-select .w-tabs .w-btn::after {
  content: ""; position: absolute; left: 14px; right: 14px; bottom: -1px; height: 2px;
  background: ${ACCENT}; opacity: 0; transition: opacity 0.15s ease;
}
#stage-select .w-tabs .w-btn:hover { background: rgb(255 255 255 / 6%); color: ${TITLE_INK}; }
#stage-select .w-tabs .w-btn.on { background: rgb(255 49 85 / 10%); color: ${ACCENT}; }
#stage-select .w-tabs .w-btn.on::after { opacity: 1; }
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
#stage-select .ss-debug {
  flex: 0 0 auto; padding-top: 12px; color: ${FAINT_INK};
  font-family: ${FONT_MONO}; font-size: 11px; cursor: pointer;
}
@media ${MQ_COMPACT} {
  #stage-select .ss-shell { place-items: center; padding-block: 12px; }
  #stage-select .ss-layout { height: 100%; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
  #stage-select .ss-3d-window,
  #stage-select .ss-window { height: auto; min-height: 0; border-radius: 24px; }
  #stage-select .ss-hero { inset: auto 20px 22px; }
  #stage-select .ss-title-main { white-space: normal; }
  #stage-select .ss-subrow { display: block; }
  #stage-select .ss-status { min-width: 0; margin-top: 14px; }
  #stage-select .ss-window {
    min-height: 0; max-height: none; padding: 16px;
  }
  #stage-select .ss-languages { flex-direction: column; gap: 7px; }
}
@media ${MQ_SHORT} {
  #stage-select .ss-shell { padding-block: 8px; }
  #stage-select .ss-layout { gap: 8px; }
  #stage-select .ss-hero { inset: auto 16px 16px; transform: scale(0.78); transform-origin: bottom left; width: 128%; }
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
      '<span class="ss-title-main">Dive into <span class="ss-title-near">Tepui</span><sup class="ss-title-formula">ℋ₀₁</sup></span>' +
      '<span class="ss-ornament-row" aria-hidden="true"><span>∴03</span><span>ECI₀</span><span>Ω⁺</span><span>⌁</span><span>⟐</span><span>⊹</span></span>' +
      '</h1>' +
      '<div class="ss-subrow"><div>' +
      '<p class="ss-sub">O high air—iron citadels wheel beneath the cold equations of orbit.</p>' +
      '<div class="ss-languages">' +
      '<p class="ss-cantonese" lang="zh-HK">前往高空<br>堡壘的作戰</p>' +
      '<p class="ss-french" lang="fr">Opération vers la forteresse de haute altitude</p>' +
      '</div>' +
      '</div><div class="ss-status"><b>∗ Link stable</b><br>h = 420.2 km · i = 51.6°<br>Epoch 06:14:28.03</div></div>' +
      '</div>' +
      '</section>' +
      '<section class="ss-window" aria-label="Stage and creative modes"></section>' +
      '</div></div>';

    // 3D角丸ウィンドウと並列する、独立したステージ選択ウィンドウ。
    const windowDiv = root.querySelector('.ss-window') as HTMLElement;
    windowDiv.innerHTML = '';
    const stageQr = document.createElement('img');
    stageQr.className = 'ss-stage-qr';
    stageQr.src = tepuiRmqrUrl;
    stageQr.alt = '';
    stageQr.setAttribute('aria-hidden', 'true');
    windowDiv.appendChild(stageQr);

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
