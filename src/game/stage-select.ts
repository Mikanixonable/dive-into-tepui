// 起動時のステージ選択画面 GUI。
// DEVELOP/UI_DESIGN_REFERENCE_V6.md の Rich title window を起動導線へ適用する。
import { STAGE_CLASSES } from './stages/stage-dictionary';
import { UnlockManager } from './unlock-manager';
import type { StageClass } from './stages/stage';
import { StageDebug } from './stages/stage-debug';
import { Button, TabBar, ValueInput } from './hud/widgets';
import { dateStringToSimTime, SIM_EPOCH_CALENDAR_TDB } from './sim-epoch';
import { KEY_MAPPING as K } from './input/key-mapping';
import { MQ_COMPACT, MQ_SHORT } from './hud/breakpoints';
import tepuiRmqrUrl from '../assets/tepui-rmqr.svg';
import {
  ACCENT, ACCENT_SECONDARY, ACCENT_SOFT, ACTIVE_THEME, BG, SURFACE_0 as THEME_SURFACE_0,
  SURFACE_1, SURFACE_2, SURFACE_3, TEXT, TEXT_DIM, TEXT_MUTED, TEXT_FAINT,
} from './theme';
import { TITLE_SCENE_PATTERNS, createTitleScene, type TitleScene } from '../render/title-scene';

const PAGE = BG;
const SURFACE_0 = THEME_SURFACE_0;
const TITLE_INK = TEXT;
const BODY_INK = TEXT_MUTED;
const MUTED_INK = TEXT_DIM;
const FAINT_INK = TEXT_FAINT;
const NEAR_ACCENT = ACCENT_SOFT;
const SECONDARY_ACCENT = ACCENT_SECONDARY;

// V6 §3 の voice 別書体。Web font が使えない環境でも role ごとのフォールバックを保つ。
const FONT_SANS = '"Arimo","Zen Kaku Gothic Antique","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif';
const FONT_SERIF = '"Cormorant Garamond","Zen Old Mincho","Hiragino Mincho ProN","Yu Mincho",serif';
const FONT_MONO = '"IBM Plex Mono","Zen Kaku Gothic Antique","Hiragino Kaku Gothic ProN","Yu Gothic",monospace';
const FONT_SCRIPT = '"Noto Serif HK","Noto Sans Cuneiform","Source Han Serif HC","Songti TC","Segoe UI Historic",serif';

const RADIUS_WINDOW = '30px';
const RADIUS_PANEL = '16px';
const RADIUS_CONTROL = '11px';

interface TitleFlavor {
  readonly primary: string;
  readonly script: string;
  readonly lang: string;
  readonly scriptKind: 'cantonese' | 'cuneiform' | 'polynesian';
  readonly note: string;
}

// 起動ごとに1組を選ぶ。3つの文字文化を同じ情報密度で扱い、タイトルの印象だけを変える。
const TITLE_FLAVORS: readonly TitleFlavor[] = [
  {
    primary: 'The Orbit Is the Battlefield.', script: '前往高空堡壘的作戰', lang: 'zh-HK', scriptKind: 'cantonese',
    note: 'Classic voice, machine measure. 古典的な声と、軌道を測る静かなUI。',
  },
  {
    primary: 'A cold path through the upper dark.', script: '𒀭𒂗𒆠 𒀀𒈾 𒀭𒊹', lang: 'sux', scriptKind: 'cuneiform',
    note: 'The old signs keep their orbit; the instruments keep time.',
  },
  {
    primary: 'Te ara o ngā whetū.', script: 'Te ara ki te rangi', lang: 'mi', scriptKind: 'polynesian',
    note: 'A path among stars, measured in quiet burns.',
  },
  {
    primary: 'Iron citadels turn beneath the equations.', script: '軌道之上，烽火未眠', lang: 'zh-HK', scriptKind: 'cantonese',
    note: 'A Cantonese signal for the watch at high altitude.',
  },
  {
    primary: 'The sky remembers every departure.', script: '𒀭𒂗𒆠 𒄑𒀀𒁲', lang: 'sux', scriptKind: 'cuneiform',
    note: 'A cuneiform fragment for a machine that never forgets.',
  },
  {
    primary: 'He moku i te rangi, he ara ki te whetū.', script: 'He ara ki te whetū', lang: 'mi', scriptKind: 'polynesian',
    note: 'Polynesian wayfinding, translated into orbital motion.',
  },
];

function randomUint32(): number {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    const bytes = new Uint32Array(1);
    globalThis.crypto.getRandomValues(bytes);
    return bytes[0] ?? 0;
  }
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

function pickRandom<T>(items: readonly T[]): T {
  return items[randomUint32() % items.length]!;
}

const STYLE = `
#stage-select {
  position: fixed; inset: 0; z-index: 100; height: 100dvh; overflow: hidden;
  background:
    radial-gradient(circle at 10% 16%, color-mix(in srgb, ${ACCENT} 6%, transparent), transparent 28rem),
    radial-gradient(circle at 88% 58%, color-mix(in srgb, ${SECONDARY_ACCENT} 5%, transparent), transparent 32rem), ${PAGE};
  color: ${BODY_INK}; font-family: ${FONT_SANS}; -webkit-font-smoothing: antialiased;
  color-scheme: ${ACTIVE_THEME.tone};
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
  width: min(100%, 900px); margin: 0; color: ${TITLE_INK}; font-weight: 500;
  font-size: clamp(48px, 8vw, 104px); letter-spacing: -0.07em; line-height: 0.82;
  text-transform: none;
}
#stage-select .ss-logo-line {
  position: relative; display: block; width: fit-content; white-space: nowrap;
}
#stage-select .ss-logo-line:nth-child(2) { margin-left: 0.42em; }
#stage-select .ss-logo-line:nth-child(3) { margin-left: 0.84em; color: ${NEAR_ACCENT}; }
#stage-select .ss-logo-ornament {
  position: absolute; left: calc(100% + 0.75rem); color: ${SECONDARY_ACCENT};
  font-family: ${FONT_MONO}; font-size: clamp(0.65rem, 1.3vw, 1.05rem);
  font-weight: 500; letter-spacing: 0.08em; line-height: 1;
}
#stage-select .ss-logo-line:nth-child(1) .ss-logo-ornament { top: 0.02em; }
#stage-select .ss-logo-line:nth-child(2) .ss-logo-ornament { bottom: 0.04em; }
#stage-select .ss-logo-line:nth-child(3) .ss-logo-ornament { top: 0.02em; }
#stage-select .ss-sub {
  width: fit-content; margin: 0 0 0 0.12em;
  color: ${ACCENT}; font-family: ${FONT_SERIF};
  font-size: clamp(21px, 3vw, 36px); font-weight: 300; line-height: 0.92;
}
#stage-select .ss-subrow {
  display: flex; align-items: end; justify-content: space-between; gap: 18px; margin-top: 20px;
}
#stage-select .ss-languages { display: flex; align-items: baseline; gap: 16px; margin: 12px 0 0 0.2em; }
#stage-select .ss-script {
  margin: 0; color: ${NEAR_ACCENT}; font-family: ${FONT_SCRIPT};
  max-width: 19em; font-size: clamp(21px, 2.8vw, 38px);
  font-weight: 700; line-height: 1.05; letter-spacing: 0.04em;
}
#stage-select .ss-script-cuneiform { font-family: "Noto Sans Cuneiform", "Segoe UI Historic", serif; font-size: clamp(19px, 2.4vw, 32px); letter-spacing: 0.12em; }
#stage-select .ss-script-polynesian { font-family: ${FONT_SERIF}; font-weight: 400; letter-spacing: 0.02em; }
#stage-select .ss-flavor-note {
  margin: 0; color: ${BODY_INK}; font-family: ${FONT_SANS};
  max-width: 28em; font-size: clamp(13px, 1.4vw, 17px); font-weight: 500; line-height: 1.3;
}
#stage-select .ss-status {
  min-width: 190px; padding: 11px 13px; border-radius: ${RADIUS_PANEL};
  color: ${BODY_INK}; background: color-mix(in srgb, ${PAGE} 58%, transparent);
  backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  font: 10px/1.55 ${FONT_MONO};
}
#stage-select .ss-status b { color: ${SECONDARY_ACCENT}; font-weight: 500; }
#stage-select .ss-window {
  position: relative;
  min-height: 0; height: 100%; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 14px;
  padding: 18px;
  background: color-mix(in srgb, ${SURFACE_1} 68%, transparent); border-radius: ${RADIUS_WINDOW};
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
#stage-select .ss-window > .ss-debug,
#stage-select .ss-window > .ss-settings { position: relative; z-index: 1; }
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
#stage-select .w-tabs { border-bottom: 1px solid color-mix(in srgb, ${TITLE_INK} 12%, transparent); }
#stage-select .w-tabs .w-btn::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  background: ${ACCENT}; opacity: 0; transition: opacity 0.15s ease;
}
#stage-select .w-tabs .w-btn:hover { background: rgb(255 255 255 / 6%); color: ${TITLE_INK}; }
#stage-select .w-tabs .w-btn.on { background: color-mix(in srgb, ${ACCENT} 10%, transparent); color: ${ACCENT}; }
#stage-select .w-tabs .w-btn.on::after { opacity: 1; }
#stage-select .ss-list {
  min-height: 0; flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px;
  padding: 2px 0;
}
#stage-select .ss-stage {
  box-sizing: border-box; min-height: 44px; padding: 14px 20px;
  border-radius: ${RADIUS_CONTROL};
  background: color-mix(in srgb, ${SURFACE_2} 82%, transparent); cursor: pointer; text-align: left;
  transition: background 0.15s ease;
}
#stage-select .ss-stage:hover { background: color-mix(in srgb, ${SURFACE_3} 78%, transparent); }
#stage-select .ss-stage.locked { opacity: 0.45; cursor: default; }
#stage-select .ss-stage.locked:hover { background: color-mix(in srgb, ${SURFACE_2} 62%, transparent); }
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
#stage-select .ss-settings {
  align-self: flex-end; flex: 0 0 auto; margin-top: 2px;
  padding: 8px 12px; border: 1px solid color-mix(in srgb, ${TITLE_INK} 18%, transparent);
  border-radius: ${RADIUS_CONTROL}; color: ${MUTED_INK}; background: transparent;
  font: 12px ${FONT_SANS}; cursor: pointer;
}
#stage-select .ss-settings:hover { color: ${TITLE_INK}; border-color: ${ACCENT}; background: color-mix(in srgb, ${ACCENT} 8%, transparent); }
#stage-select .ss-datetime { display: flex; flex-direction: column; gap: 14px; }
#stage-select .ss-datetime.hidden { display: none; }
#stage-select .ss-datetime-fields { display: flex; flex-wrap: wrap; gap: 12px; }
#stage-select .ss-datetime-field {
  display: flex; flex-direction: column; gap: 4px;
  color: ${MUTED_INK}; font-family: ${FONT_SANS}; font-size: 11px; letter-spacing: 0.04em;
}
#stage-select .ss-datetime-field .w-input { width: 88px; }
#stage-select .ss-datetime-error { margin: 0; color: ${SECONDARY_ACCENT}; font-size: 12px; }
#stage-select .ss-datetime-error.hidden { display: none; }
#stage-select .ss-datetime-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: auto; }
@media ${MQ_COMPACT} {
  #stage-select .ss-shell { place-items: center; padding-block: 12px; }
  #stage-select .ss-layout { height: 100%; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
  #stage-select .ss-3d-window,
  #stage-select .ss-window { height: auto; min-height: 0; border-radius: 24px; }
  #stage-select .ss-hero { inset: auto 20px 22px; }
  #stage-select .ss-subrow { display: block; }
  #stage-select .ss-status { min-width: 0; margin-top: 14px; }
  #stage-select .ss-window {
    min-height: 0; max-height: none; padding: 16px;
  }
  #stage-select .ss-languages { flex-direction: column; gap: 7px; }
  #stage-select .ss-script { max-width: 100%; }
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
  link.href = 'https://fonts.googleapis.com/css2?family=Arimo:wght@400;500;600&family=Cormorant+Garamond:wght@300;400&family=IBM+Plex+Mono:wght@500&family=Noto+Sans+Cuneiform&family=Noto+Serif+HK:wght@700&family=Zen+Kaku+Gothic+Antique:wght@400;500;600&family=Zen+Old+Mincho:wght@400&display=swap';
  document.head.appendChild(link);
}

// 起動選択画面(各ステージの selectGroup ごとのタブ)を表示し、選ばれたステージクラス(クリエイティブ
// なら指定した開始日時の simTime オフセットも併せて)で解決される Promise を返す。
export function selectStage(
  unlockManager: UnlockManager,
  onEscape?: () => void,
  onClose?: () => void,
  onSettings?: () => void,
): Promise<{ stageClass: StageClass; startSimTime?: number }> {
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
      '<h1 id="ss-title" class="ss-logotype" aria-label="Dive into Tepui">' +
      '<span class="ss-logo-line">Dive<sup class="ss-logo-ornament">∴03</sup></span>' +
      '<span class="ss-logo-line">into<sub class="ss-logo-ornament">ECI₀</sub></span>' +
      '<span class="ss-logo-line">Tepui<sup class="ss-logo-ornament">Ω⁺</sup></span>' +
      '</h1>' +
      '<div class="ss-subrow"><div>' +
      '<p class="ss-sub" data-flavor-primary></p>' +
      '<div class="ss-languages">' +
      '<p class="ss-script" data-flavor-script></p>' +
      '<p class="ss-flavor-note" data-flavor-note></p>' +
      '</div>' +
      '</div><div class="ss-status"><b>∗ Link stable</b><br>h = 420.2 km · i = 51.6°<br>Epoch 06:14:28.03</div></div>' +
      '</div>' +
      '</section>' +
      '<section class="ss-window" aria-label="Stage and creative modes"></section>' +
      '</div></div>';

    const flavor = pickRandom(TITLE_FLAVORS);
    const flavorPrimary = root.querySelector<HTMLElement>('[data-flavor-primary]')!;
    const flavorScript = root.querySelector<HTMLElement>('[data-flavor-script]')!;
    const flavorNote = root.querySelector<HTMLElement>('[data-flavor-note]')!;
    flavorPrimary.textContent = flavor.primary;
    flavorScript.textContent = flavor.script;
    flavorScript.lang = flavor.lang;
    flavorScript.classList.add(`ss-script-${flavor.scriptKind}`);
    flavorNote.textContent = flavor.note;

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
        if (enabled) {
          row.addEventListener('click', () => {
            if (stageClass.id === 'creative') openDateTimeStep(stageClass);
            else done(stageClass);
          });
        }
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

    const settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'ss-settings';
    settingsButton.textContent = '⚙ 設定';
    settingsButton.addEventListener('click', () => onSettings?.());
    windowDiv.appendChild(settingsButton);

    // クリエイティブモード開始日時の指定画面(GAME.md 9.0)。年/月/日/時/分の5欄を持ち、
    // 有効な日時のときだけ確定ボタンを押せる。
    const dateTimeDiv = document.createElement('div');
    dateTimeDiv.className = 'ss-datetime hidden';
    const dateTimeTitle = document.createElement('p');
    dateTimeTitle.className = 'ss-window-title';
    dateTimeTitle.textContent = '開始日時';
    dateTimeDiv.appendChild(dateTimeTitle);
    const fieldsDiv = document.createElement('div');
    fieldsDiv.className = 'ss-datetime-fields';
    dateTimeDiv.appendChild(fieldsDiv);
    const errorP = document.createElement('p');
    errorP.className = 'ss-datetime-error';
    dateTimeDiv.appendChild(errorP);
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'ss-datetime-actions';
    dateTimeDiv.appendChild(actionsDiv);
    windowDiv.appendChild(dateTimeDiv);

    const epoch = SIM_EPOCH_CALENDAR_TDB;
    const fieldDefs: readonly [label: string, initial: number][] = [
      ['年', epoch.year], ['月', epoch.month], ['日', epoch.day], ['時', epoch.hour], ['分', epoch.minute],
    ];
    const inputs = fieldDefs.map(([label, initial]) => {
      const field = document.createElement('label');
      field.className = 'ss-datetime-field';
      const span = document.createElement('span');
      span.textContent = label;
      field.appendChild(span);
      const input = new ValueInput({ type: 'number', step: 1 }, () => validate());
      input.setValue(String(initial));
      input.element.addEventListener('input', validate);
      field.appendChild(input.element);
      fieldsDiv.appendChild(field);
      return input;
    });
    const startButton = new Button('開始', () => {
      const simTime = readSimTime();
      if (simTime === null) return;
      done(pendingCreativeStage!, simTime);
    });
    const backButton = new Button('戻る', () => {
      dateTimeStepOpen = false;
      dateTimeDiv.classList.add('hidden');
      listDiv.classList.remove('hidden');
      tabBar.element.classList.remove('hidden');
    });
    actionsDiv.appendChild(backButton.element);
    actionsDiv.appendChild(startButton.element);

    // 年+2桁パディングした月日時分から parseCalendarDate が要求する拡張ISO形式を組み立てる。
    const pad2 = (n: number) => String(n).padStart(2, '0');
    // 5欄の入力値から simTime オフセットを求める。数値でない/存在しない日時なら null。
    const readSimTime = (): number | null => {
      if (inputs.some((input) => input.element.value.trim() === '' || !isFinite(Number(input.element.value)))) return null;
      const [year, month, day, hour, minute] = inputs.map((input) => Number(input.element.value)) as [number, number, number, number, number];
      const iso = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00`;
      return dateStringToSimTime(iso);
    };
    // 入力のたびに確定ボタンの有効/無効とエラーメッセージを更新する。
    const validate = () => {
      const simTime = readSimTime();
      startButton.setEnabled(simTime !== null);
      errorP.classList.toggle('hidden', simTime !== null);
    };
    errorP.textContent = '存在しない日時です。';
    validate();

    let pendingCreativeStage: StageClass | null = null;
    let dateTimeStepOpen = false;
    // 一覧・タブを隠して日時入力欄を出す。開いている間は他ステージのショートカットキーを止める。
    const openDateTimeStep = (stageClass: StageClass) => {
      pendingCreativeStage = stageClass;
      dateTimeStepOpen = true;
      listDiv.classList.add('hidden');
      tabBar.element.classList.add('hidden');
      dateTimeDiv.classList.remove('hidden');
    };

    document.body.appendChild(root);

    // 3D 場面は非同期に立ち上がる。選択が先に済んだ場合はでき次第そのまま破棄する。
    let scene: TitleScene | null = null;
    let selected = false;
    const titlePattern = pickRandom(TITLE_SCENE_PATTERNS);
    createTitleScene(
      root.querySelector('.ss-canvas') as HTMLCanvasElement,
      root.querySelector('.ss-3d-window') as HTMLElement,
      { pattern: titlePattern, seed: randomUint32() },
    )
      .then((s) => { scene = s; if (selected) s.dispose(); })
      .catch(() => {});

    // 選択確定: 3D 場面と画面を片付けて Promise を解決する
    const done = (stageClass: StageClass, startSimTime?: number) => {
      window.removeEventListener('keydown', onKey);
      onClose?.();
      selected = true;
      scene?.dispose();
      root.remove();
      resolve({ stageClass, startSimTime });
    };
    // 解放済みステージのショートカットキーにマッチしたら選択確定する。タブに関係なく効く。
    const onKey = (e: KeyboardEvent) => {
      if (e.code === K.pauseMenu.code) {
        e.preventDefault();
        onEscape?.();
        return;
      }
      // 設定/一時停止などのシステム窓が開いている間は、背後のステージ選択ショートカットを
      // 起動しない。ESC だけは上の分岐で現在の最前面窓へ配送する。
      if (document.body.classList.contains('hud-overlay-modal-open')) return;
      if (dateTimeStepOpen) return;
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
