// マップ実マーカーが使う SVG 形状の定義。船は鏃(やじり)形、基地は正七角形 — マーカー本体
// (headingHpMarkerSvg 等)と HUD の一覧パネルの凡例アイコンが同じ形を指せるよう、依存フリーな
// 文字列組み立てだけをここへ集める。three/hud/player など重い・循環しうるモジュールは import しない。


const COLOR_MARKER_HP_EMPTY = 'rgba(120, 125, 130, .2)';

export const SHIP_ARROWHEAD_POINTS = '12,1.5 17.5,21 12,16.5 6.5,21';

const BASE_HEPTAGON_POINTS = '12,2.5 19.43,6.08 21.26,14.11 16.12,20.56 7.88,20.56 2.74,14.11 4.57,6.08';

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

// 正三角形を辺中央の切り欠きで分割し、残HPに応じて発光するSVGを生成する。
// 分割数は3の倍数へ丸めるため、将来HPが12/18になっても多重リングへ拡張しやすい。
export function triangleHpMarkerSvg(hp: number, maxHp: number): string {
  const segments = Math.max(3, Math.round(maxHp / 3) * 3);
  const lit = Math.max(0, Math.min(segments, Math.round((hp / maxHp) * segments)));
  // 正三角形のシルエット(辺長18、外接円中心は(12,12))。
  const points: [number, number][] = [[12, 3], [21, 18.588], [3, 18.588]];
  const lines: string[] = [];
  const emit = (i: number, j: number, k: number, a: number, b: number): void => {
    if (b <= a) return;
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % 3]!;
    const color = (i * k + j) < lit ? 'currentColor' : COLOR_MARKER_HP_EMPTY;
    lines.push(`<line x1="${x1 + (x2 - x1) * a}" y1="${y1 + (y2 - y1) * a}" x2="${x1 + (x2 - x1) * b}" y2="${y1 + (y2 - y1) * b}" stroke="${color}" stroke-width="1.5" stroke-linecap="butt"/>`);
  };
  for (let i = 0; i < 3; i++) {
    const k = segments / 3;
    const notch = 0.09;
    const notchStart = 0.5 - notch / 2;
    const notchEnd = 0.5 + notch / 2;
    // 頂点は連続させ、各辺の中央だけを切り欠く(境界がちょうど0.5に重なる分割数でも欠ける)。
    for (let j = 0; j < k; j++) {
      const a = j / k;
      const b = (j + 1) / k;
      if (a < notchEnd && b > notchStart) {
        if (a < notchStart) emit(i, j, k, a, notchStart);
        if (b > notchEnd) emit(i, j, k, notchEnd, b);
      } else {
        emit(i, j, k, a, b);
      }
    }
  }
  return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="HP ${Math.max(0, hp)} / ${maxHp}">${lines.join('')}</svg>`;
}
