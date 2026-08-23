// マップ実マーカーが使う SVG 形状の定義。船は鏃(やじり)形、基地は正七角形 — マーカー本体
// (headingHpMarkerSvg 等)と HUD の一覧パネルの凡例アイコンが同じ形を指せるよう、依存フリーな
// 文字列組み立てだけをここへ集める。three/hud/player など重い・循環しうるモジュールは import しない。

export const SHIP_ARROWHEAD_POINTS = '12,1.5 17.5,21 12,16.5 6.5,21';

export const BASE_HEPTAGON_POINTS = '12,2.5 19.43,6.08 21.26,14.11 16.12,20.56 7.88,20.56 2.74,14.11 4.57,6.08';

// HP に依存しない鏃形アイコン単体。filled は自艦・味方、中抜きは敵を想定。
export function shipMarkerSvg(filled: boolean): string {
  const style = filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.8"';
  return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="Ship">` +
    `<polygon points="${SHIP_ARROWHEAD_POINTS}" ${style}/>` +
    `</svg>`;
}

export function baseMarkerSvg(): string {
  return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="Base">` +
    `<polygon points="${BASE_HEPTAGON_POINTS}" fill="none" stroke="currentColor" stroke-width="1.8"/>` +
    `</svg>`;
}
