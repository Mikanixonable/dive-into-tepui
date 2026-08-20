// 機体の残 HP をマーカーの図形そのもので示す SVG。戦闘ビューは切り欠きの点灯数で、
// マップビューは進行方向へ回しても崩れない塗り高さで示す。
import * as C from '../const';

// 逆三角形を辺中央の切り欠きで分割し、残HPに応じて発光するSVGを生成する。
// 分割数は3の倍数へ丸めるため、将来HPが12/18になっても多重リングへ拡張しやすい。
export function notchedHpMarkerSvg(hp: number, maxHp: number): string {
  const segments = Math.max(3, Math.round(maxHp / 3) * 3);
  const lit = Math.max(0, Math.min(segments, Math.round((hp / maxHp) * segments)));
  // 後部がV字にへこんだ鋭角矢尻シルエット(3/5角度: 12,1.5 -> 17.5,21 -> 12,16.5 -> 6.5,21)。
  const points: [number, number][] = [[12, 1.5], [17.5, 21], [12, 16.5], [6.5, 21]];
  const lines: string[] = [];
  const emit = (i: number, j: number, k: number, a: number, b: number): void => {
    if (b <= a) return;
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % 4]!;
    const color = (i * k + j) < lit ? 'currentColor' : C.COLOR_MARKER_HP_EMPTY;
    lines.push(`<line x1="${x1 + (x2 - x1) * a}" y1="${y1 + (y2 - y1) * a}" x2="${x1 + (x2 - x1) * b}" y2="${y1 + (y2 - y1) * b}" stroke="${color}" stroke-width="1.5" stroke-linecap="butt"/>`);
  };
  for (let i = 0; i < 4; i++) {
    const k = segments / 4;
    // 頂点は連続させ、各辺の中央だけを切り欠く。
    for (let j = 0; j < k; j++) {
      const a = j / k;
      const b = (j + 1) / k;
      const notch = 0.09;
      if (a < 0.5 && b > 0.5) {
        emit(i, j, k, a, 0.5 - notch / 2);
        emit(i, j, k, 0.5 + notch / 2, b);
      } else {
        emit(i, j, k, a, b);
      }
    }
  }
  return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="HP ${Math.max(0, hp)} / ${maxHp}">${lines.join('')}</svg>`;
}

// 進行方向へ回転させても崩れない HP 表現。後部が凹んだ鋭角矢尻の外形と、底辺からの塗り高さで
// 残HP比を示す。自勢力は単色塗りつぶし、敵対勢力は中抜きスタイル。
export function headingHpMarkerSvg(hp: number, maxHp: number, name: string, hollow: boolean): string {
  const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  const apexY = 1.5;
  const baseY = 21;
  const fillTopY = (baseY - ratio * (baseY - apexY)).toFixed(2);
  const clipId = `hpfill-${name}`;
  const pts = '12,1.5 17.5,21 12,16.5 6.5,21';
  const label = `HP ${Math.max(0, hp)} / ${maxHp}`;
  if (hollow) {
    return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="${label}">` +
      `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8"/>` +
      `</svg>`;
  }
  return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="${label}">` +
    `<clipPath id="${clipId}"><rect x="0" y="${fillTopY}" width="24" height="24"/></clipPath>` +
    `<polygon points="${pts}" fill="currentColor" fill-opacity="1" clip-path="url(#${clipId})"/>` +
    `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
    `</svg>`;
}

// 基地モジュールを積んだ機体のマーカー図形。
export function baseMarkerSvg(): string {
  const pts = "12,2.5 19.43,6.08 21.26,14.11 16.12,20.56 7.88,20.56 2.74,14.11 4.57,6.08";
  return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="基地">` +
    `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8"/>` +
    `</svg>`;
}

// 機体1つぶんのマーカー図形を種別・表示モードから決める。基地モジュールを積んでいれば
// 常に七角形、それ以外はマップビューなら進行方向対応、戦闘ビューなら切り欠き HP 表現。
export function vesselMarkerSvg(
  isBase: boolean, hp: number, maxHp: number, name: string, overviewMode: boolean, hollow: boolean,
): string {
  if (isBase) return baseMarkerSvg();
  return overviewMode ? headingHpMarkerSvg(hp, maxHp, name, hollow) : notchedHpMarkerSvg(hp, maxHp);
}
