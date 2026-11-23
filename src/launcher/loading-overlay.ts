// WebGPU 初期化や天体暦の構築など、しばらく無反応になり得る処理の間に表示する読み込み画面。
// showLoading/hideLoading の対で開閉し、表示中かどうかはこのモジュール自身が持つ。
import { Z_LOADING_OVERLAY } from '../theme';
import type { LoadingStep } from '../game/loading-progress';

// 三つの点の動きは CSS アニメーションだけで組む。シェーダの事前コンパイルで主スレッドが塞がっている間も、
// 合成側で再生され続ける。個数・作業名・色の更新は主スレッドが動いたときだけ進む。
const DOT_SIZE_PX = 10;
const DOT_PITCH_PX = 18;
const DOT_CYCLE_S = 6;
const DOT_EASING = 'cubic-bezier(0.83, 0, 0.17, 1)';
const INITIAL_NOTE = '初期化中(WebGPU)…';
const DOT_COUNT = 3;

// 一周 6 秒で、波・公転・合体・呼吸の 4 幕を巡る。位置は点の間隔 DOT_PITCH_PX を 1 とした値。
// 各行は [キーフレームの位置, x, y, 拡大率]。3 点とも列の姿勢から始まり、列の姿勢へ戻る。
type DotFrame = readonly [stops: string, x: number, y: number, scale: number];
const HOP = 0.5; // 波で跳ねる高さ
const TRI_TOP = 0.89; // 公転で三角形に開いたときの頂点までの距離
const TRI_X = 0.78;
const TRI_Y = 0.44;
const DOT_FRAMES: readonly (readonly DotFrame[])[] = [
  [
    ['0%', -1, 0, 1], ['6%', -1, -HOP, 1], ['12%,25%', -1, 0, 1],
    ['33%', 0, -TRI_TOP, 0.8], ['41%', TRI_X, TRI_Y, 0.8], ['50%', -TRI_X, TRI_Y, 0.8],
    ['58%,62%', 0, 0, 1.5], ['70%,75%', -1, 0, 1], ['83%', -1, 0, 0.4], ['91%', -1, 0, 1.15], ['100%', -1, 0, 1],
  ],
  [
    ['0%,4%', 0, 0, 1], ['10%', 0, -HOP, 1], ['16%,25%', 0, 0, 1],
    ['33%', TRI_X, TRI_Y, 0.8], ['41%', -TRI_X, TRI_Y, 0.8], ['50%', 0, -TRI_TOP, 0.8],
    ['58%,62%', 0, 0, 0.01], ['70%,75%', 0, 0, 1], ['83%,86%', 0, 0, 0.4], ['94%', 0, 0, 1.15], ['100%', 0, 0, 1],
  ],
  [
    ['0%,8%', 1, 0, 1], ['14%', 1, -HOP, 1], ['20%,25%', 1, 0, 1],
    ['33%', -TRI_X, TRI_Y, 0.8], ['41%', 0, -TRI_TOP, 0.8], ['50%', TRI_X, TRI_Y, 0.8],
    ['58%,62%', 0, 0, 0.01], ['70%,75%', 1, 0, 1], ['83%,89%', 1, 0, 0.4], ['97%', 1, 0, 1.15], ['100%', 1, 0, 1],
  ],
];

const px = (pitches: number): string => `${(pitches * DOT_PITCH_PX).toFixed(1)}px`;

// 1 つの点の一周ぶんを CSS の @keyframes 文字列にする。
function dotKeyframes(index: number, frames: readonly DotFrame[]): string {
  const body = frames
    .map(([stops, x, y, scale]) => `${stops}{transform:translate(${px(x)},${px(y)}) scale(${scale})}`)
    .join('');
  return `@keyframes loading-dot-${index}{${body}}`;
}

const STYLE_TEXT = `
.loading-overlay{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:var(--space-6);color:var(--text);background:var(--bg);font-family:var(--font-family);z-index:${Z_LOADING_OVERLAY};text-align:center}
.loading-title{font-size:var(--font-2xl);letter-spacing:6px;color:var(--color-primary)}
.loading-dots{position:relative;width:${px(DOT_COUNT)};height:${px(1.4)}}
.loading-dots i{position:absolute;left:50%;top:50%;width:${DOT_SIZE_PX}px;height:${DOT_SIZE_PX}px;margin:${-DOT_SIZE_PX / 2}px;
  border-radius:50%;background:color-mix(in oklab,var(--color-primary) calc(var(--ratio,0) * 100%),var(--text-faint));
  transform:translate(var(--rest-x),0);transition:background-color var(--transition-slow),box-shadow var(--transition-slow)}
.loading-dots i.filled{box-shadow:0 0 var(--space-4) color-mix(in srgb,var(--color-primary) var(--glow-weak),transparent)}
.loading-dots i:nth-child(1){--rest-x:${px(-1)};animation:loading-dot-0 ${DOT_CYCLE_S}s ${DOT_EASING} infinite}
.loading-dots i:nth-child(2){--rest-x:0px;animation:loading-dot-1 ${DOT_CYCLE_S}s ${DOT_EASING} infinite}
.loading-dots i:nth-child(3){--rest-x:${px(1)};animation:loading-dot-2 ${DOT_CYCLE_S}s ${DOT_EASING} infinite}
${DOT_FRAMES.map((frames, i) => dotKeyframes(i, frames)).join('\n')}
.loading-status{display:flex;flex-direction:column;align-items:center;gap:var(--space-2)}
.loading-count{height:1.4em;font-size:var(--font-xl);letter-spacing:.08em;color:var(--text-dim);font-variant-numeric:tabular-nums}
.loading-count b{font-weight:normal;color:var(--text)}
.loading-note{max-width:calc(100vw - var(--space-6) * 2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:var(--font-s);color:var(--text-dim)}
@media (prefers-reduced-motion: reduce){.loading-dots i{animation:none}}
`;

interface LoadingView {
  readonly overlay: HTMLElement;
  readonly style: HTMLStyleElement;
  readonly dots: readonly HTMLElement[];
  readonly count: HTMLElement;
  readonly note: HTMLElement;
}

let view: LoadingView | null = null;

// className と任意の文字列を持つ要素を作る。
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ローディング表示を出す。既に出ていれば何もしない。進捗は 0% から始まる。
export function showLoading(): void {
  if (view) return;
  // 見た目はこの画面だけのものなので、HUD の CSS が組まれる前から使えるよう自前の style 要素で持つ。
  const style = document.createElement('style');
  style.textContent = STYLE_TEXT;
  document.head.appendChild(style);

  const overlay = element('div', 'loading-overlay');
  const dotsHost = element('div', 'loading-dots');
  const dots = Array.from({ length: DOT_COUNT }, () => dotsHost.appendChild(document.createElement('i')));
  const count = element('div', 'loading-count');
  const note = element('div', 'loading-note', INITIAL_NOTE);
  const status = element('div', 'loading-status');
  status.append(count, note);
  overlay.append(element('div', 'loading-title', 'Dive into Tepui'), dotsHost, status);
  document.body.appendChild(overlay);

  view = { overlay, style, dots, count, note };
  paintDots(view, 0);
}

// 各点が全体の 1/3 を受け持ち、左から順に灰から主役色へ色づく。
function paintDots(v: LoadingView, ratio: number): void {
  v.dots.forEach((dot, i) => {
    const share = Math.max(0, Math.min(1, ratio * DOT_COUNT - i));
    dot.style.setProperty('--ratio', share.toFixed(3));
    dot.classList.toggle('filled', share >= 1);
  });
}

// 終えた数と全体の数を「03 / 12」の形で出す。終えた数だけ強く見せる。
function paintCount(v: LoadingView, step: LoadingStep): void {
  const done = element('b', '', String(step.done).padStart(2, '0'));
  v.count.replaceChildren(done, ` / ${step.total}`);
}

// 進捗(0..1)を三つの点の色へ、step を個数へ、note を作業名へ反映する。表示中でなければ何もしない。
export function setLoadingProgress(ratio: number, note?: string, step?: LoadingStep): void {
  if (!view) return;
  paintDots(view, Math.max(0, Math.min(1, ratio)));
  if (step !== undefined) paintCount(view, step);
  if (note !== undefined) view.note.textContent = note;
}

// ローディング表示を片付ける。出ていなければ何もしない。
export function hideLoading(): void {
  view?.overlay.remove();
  view?.style.remove();
  view = null;
}
