// ゲームタイトル「Dive into Tepui」のロゴタイプ。タイトル画面とESCメニューが同じ文字・装飾記号・
// 書体で組む。書体の配信元は Google Fonts で、読み込めない環境では各スタックの OS フォールバックで
// レイアウトを保つ。
import { injectOnce } from './inject-style';

// ロゴタイプ本文の書体スタック。タイトル画面全体の本文書体としても使う。
export const TITLE_FONT_SANS = '"Arimo","Zen Kaku Gothic Antique","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif';
// 装飾記号と、タイトル画面の数値・補助表示が使う等幅書体スタック。
export const TITLE_FONT_MONO = '"IBM Plex Mono","Zen Kaku Gothic Antique","Hiragino Kaku Gothic ProN","Yu Gothic",monospace';
const TITLE_FONTS_URL = 'https://fonts.googleapis.com/css2?family=Arimo:wght@400;500;600&family=Cormorant+Garamond:wght@300;400&family=IBM+Plex+Mono:wght@500&family=Noto+Sans+Cuneiform&family=Noto+Serif+HK:wght@700&family=Zen+Kaku+Gothic+Antique:wght@400;500;600&family=Zen+Old+Mincho:wght@400&display=swap';

// 3行の行要素と各行へ添える装飾記号。.title-logotype を持つ要素の中身として置く。
// 文字サイズは置かれる画面ごとに決めるため、ここでは持たない。
export const TITLE_LOGOTYPE_HTML =
  '<span>Dive<sup aria-hidden="true">∴03</sup></span>' +
  '<span>into<sub aria-hidden="true">ECI₀</sub></span>' +
  '<span>Tepui<sup aria-hidden="true">Ω⁺</sup></span>';

const TITLE_LOGOTYPE_STYLE = `
.title-logotype {
  margin: 0; color: var(--text); font-family: ${TITLE_FONT_SANS}; font-weight: 500;
  letter-spacing: -0.07em; line-height: 0.82; text-transform: none;
}
.title-logotype > span { position: relative; display: block; width: fit-content; white-space: nowrap; }
.title-logotype > span:nth-child(2) { margin-left: 0.42em; }
.title-logotype > span:nth-child(3) { margin-left: 0.84em; color: var(--color-primary-hover); }
.title-logotype sup, .title-logotype sub {
  position: absolute; left: calc(100% + 0.75rem); color: var(--color-signal);
  font-family: ${TITLE_FONT_MONO}; font-size: clamp(0.65rem, 1.3vw, 1.05rem);
  font-weight: 500; letter-spacing: 0.08em; line-height: 1;
}
.title-logotype > span:nth-child(1) sup { top: 0.02em; }
.title-logotype > span:nth-child(2) sub { bottom: 0.04em; }
.title-logotype > span:nth-child(3) sup { top: 0.02em; }
`;

// ロゴタイプの CSS と専用書体を、それぞれ一度だけ document.head へ入れる。
export function injectTitleLogotypeStyle(): void {
  injectOnce('title-logotype', TITLE_LOGOTYPE_STYLE);
  if (document.getElementById('title-fonts')) return;
  const link = document.createElement('link');
  link.id = 'title-fonts';
  link.rel = 'stylesheet';
  link.href = TITLE_FONTS_URL;
  document.head.appendChild(link);
}
