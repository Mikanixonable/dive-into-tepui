// ステージ選択画面(#stage-select)の CSS。
import { MQ_COMPACT, MQ_SHORT } from '../hud/breakpoints';
import { injectOnce } from '../hud/inject-style';
import { injectCommonUiStyle } from '../hud/style/common-ui-style';
import {
  injectTitleLogotypeStyle, TITLE_FONT_MONO, TITLE_FONT_SANS,
} from '../hud/title-logotype';
import { Z_STAGE_SELECT } from '../theme';

// 声(voice)ごとの書体。Web font が使えない環境でも role ごとのフォールバックを保つ。
const FONT_SERIF = '"Cormorant Garamond","Zen Old Mincho","Hiragino Mincho ProN","Yu Mincho",serif';
const FONT_SCRIPT = '"Noto Serif HK","Noto Sans Cuneiform","Source Han Serif HC","Songti TC","Segoe UI Historic",serif';

// TODO: 角丸の段(RADIUS_WINDOW = 22px)に無い値。段へ揃えるか、段として足すかを決める。
const STAGE_SELECT_WINDOW_RADIUS = '30px';

const STAGE_SELECT_STYLE = `
#stage-select {
  position: fixed; inset: 0; z-index: ${Z_STAGE_SELECT}; height: 100dvh; overflow: hidden;
  background:
    radial-gradient(circle at 10% 16%, color-mix(in srgb, var(--color-primary) 6%, transparent), transparent 28rem),
    radial-gradient(circle at 88% 58%, color-mix(in srgb, var(--color-signal) 5%, transparent), transparent 32rem), var(--bg);
  color: var(--text-muted); font-family: ${TITLE_FONT_SANS}; -webkit-font-smoothing: antialiased;
  color-scheme: var(--theme-tone);
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
  overflow: hidden; isolation: isolate; border: 0;
  border-radius: ${STAGE_SELECT_WINDOW_RADIUS}; background: var(--surface-0);
  box-shadow: var(--glass-shadow);
}
#stage-select .ss-scene {
  position: absolute; inset: 0; z-index: 0; background: var(--surface-0);
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
  color: var(--color-primary); font-family: ${TITLE_FONT_MONO};
  font-size: 10px; font-weight: 500; letter-spacing: 0.08em;
}
#stage-select .ss-eyebrow::before {
  content: ""; width: 28px; height: 2px; border-radius: 99px; background: var(--color-primary);
}
#stage-select .title-logotype {
  width: min(100%, 900px); font-size: clamp(48px, 8vw, 104px);
}
#stage-select .ss-sub {
  width: fit-content; margin: 0 0 0 0.12em;
  color: var(--color-primary); font-family: ${FONT_SERIF};
  font-size: clamp(21px, 3vw, 36px); font-weight: 300; line-height: 0.92;
}
#stage-select .ss-subrow {
  display: flex; align-items: end; justify-content: space-between; gap: 18px; margin-top: 20px;
}
#stage-select .ss-languages {
  display: flex; align-items: flex-end; flex-wrap: wrap; gap: 10px 16px; margin: 12px 0 0 0.2em;
}
#stage-select .ss-script-block { min-width: 0; max-width: 100%; }
#stage-select .ss-script-block[hidden] { display: none; }
#stage-select .ss-script {
  margin: 0; color: var(--color-primary-hover); font-family: ${FONT_SCRIPT};
  max-width: 19em; font-size: clamp(21px, 2.8vw, 38px);
  font-weight: 700; line-height: 1.05; letter-spacing: 0.04em;
}
#stage-select .ss-script-cuneiform {
  font-family: "Noto Sans Cuneiform", "Segoe UI Historic", serif;
  font-size: clamp(19px, 2.4vw, 32px); letter-spacing: 0.12em;
}
#stage-select .ss-script-polynesian { font-family: ${FONT_SERIF}; font-weight: 400; letter-spacing: 0.02em; }
#stage-select .ss-transliteration {
  margin: 5px 0 0; color: var(--text-dim); font-family: ${TITLE_FONT_MONO};
  font-size: clamp(10px, 1vw, 12px); font-weight: 500; line-height: 1.35; letter-spacing: 0.035em;
}
#stage-select .ss-transliteration[hidden] { display: none; }
#stage-select .ss-flavor-note {
  flex: 1 1 16em; margin: 0; color: var(--text-muted); font-family: ${TITLE_FONT_SANS};
  max-width: 30em; font-size: clamp(11px, 1.15vw, 14px); font-weight: 500;
  line-height: 1.35; letter-spacing: 0.025em;
}
#stage-select .ss-status {
  min-width: 190px; padding: 11px 13px; border-radius: var(--radius-panel);
  color: var(--text-muted);
  font: 10px/1.55 ${TITLE_FONT_MONO};
}
#stage-select .ss-status b { color: var(--color-signal); font-weight: 500; }
#stage-select .ss-window {
  position: relative;
  min-height: 0; height: 100%; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 14px;
  padding: 18px;
  border-radius: ${STAGE_SELECT_WINDOW_RADIUS};
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
  margin: 0 0 2px 8px; color: var(--text-dim);
  font-size: 15px; font-weight: 600; letter-spacing: 0.04em;
}
#stage-select .w-tabs {
  gap: var(--space-1); padding: var(--space-1); border: 0;
  border-radius: var(--radius-panel);
}
#stage-select .w-tabs .w-btn {
  position: relative; flex: 1; min-height: 44px; padding: var(--space-3) var(--space-4);
  display: inline-flex; align-items: center; justify-content: center; text-align: center;
  border: 0; border-radius: var(--radius-control);
  background: transparent; color: var(--text-dim);
  font-family: ${TITLE_FONT_SANS}; font-size: 13px; font-weight: 600; letter-spacing: 0.04em;
}
#stage-select .w-tabs .w-btn::after {
  display: none;
}
#stage-select .w-tabs .w-btn:hover { background: var(--glass-control-hover); color: var(--text); }
#stage-select .w-tabs .w-btn.on {
  background: var(--color-primary-fill); color: var(--color-primary);
}
#stage-select .ss-list {
  min-height: 0; flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px;
  padding: 2px 0;
}
#stage-select .ss-stage {
  box-sizing: border-box; min-height: 44px; padding: 14px 20px;
  border-radius: var(--radius-control);
  background: var(--glass-control); border: 0; cursor: pointer; text-align: left;
  transition: background var(--transition-fast);
}
#stage-select .ss-stage:hover { background: var(--glass-control-hover); }
#stage-select .ss-stage.locked { opacity: 0.45; cursor: default; }
#stage-select .ss-stage.locked:hover { background: color-mix(in srgb, var(--surface-2) 62%, transparent); }
#stage-select .ss-stage-label {
  display: flex; align-items: baseline; gap: 10px;
  color: var(--text); font-size: 19px; letter-spacing: 0.04em; line-height: 1.4;
}
#stage-select .ss-stage:not(.locked):hover .ss-stage-label { color: var(--color-primary-hover); }
#stage-select .ss-stage.locked .ss-stage-label { color: var(--text-faint); }
#stage-select .ss-stage-key { font-family: ${TITLE_FONT_MONO}; font-size: 11px; font-weight: 500; color: var(--text-dim); }
#stage-select .ss-stage-sub { margin-top: 3px; color: var(--text-dim); font-size: 12px; line-height: 1.55; }
#stage-select .ss-debug {
  flex: 0 0 auto; padding-top: 12px; color: var(--text-faint);
  font-family: ${TITLE_FONT_MONO}; font-size: 11px; cursor: pointer;
}
#stage-select .ss-settings {
  align-self: flex-end; flex: 0 0 auto; margin-top: 2px;
  padding: var(--space-3) var(--space-4); border: 0;
  border-radius: var(--radius-control); color: var(--text-dim); background: var(--glass-control);
  font: 12px ${TITLE_FONT_SANS}; cursor: pointer;
}
#stage-select .ss-settings:hover { color: var(--text); background: var(--glass-control-hover); }
#stage-select .hidden { display: none !important; }
#stage-select .ss-datetime { display: flex; flex-direction: column; gap: 14px; }
#stage-select .ss-datetime-fields { display: flex; flex-wrap: wrap; gap: 12px; }
#stage-select .ss-datetime-field {
  display: flex; flex-direction: column; gap: 4px;
  color: var(--text-dim); font-family: ${TITLE_FONT_SANS}; font-size: 11px; letter-spacing: 0.04em;
}
#stage-select .ss-datetime-field .w-input { width: 88px; }
#stage-select .ss-datetime-error { margin: 0; color: var(--color-signal); font-size: 12px; }
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

// 共通 UI・ロゴタイプとこの画面の CSS、タイトル専用書体を、それぞれ一度だけ document.head へ入れる。
export function injectStageSelectStyle(): void {
  injectCommonUiStyle();
  injectTitleLogotypeStyle();
  injectOnce('stage-select-style', STAGE_SELECT_STYLE);
}
