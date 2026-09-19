import { SHIP_ARROWHEAD_POINTS, triangleHpMarkerSvg } from './marker-shapes';

// 船体の HP 表現だけを担当する renderer。船の物理・部品構成は知らない。
// 塗りのクリップ形は SVG の id で引くので、艦の識別子から重複しない id を作る。
export class ShipMarkerRenderer {
  private readonly clipId: string;

  // ownerId は同じ画面に並ぶ艦どうしで重複しない識別子を渡す。
  public constructor(ownerId: string) {
    this.clipId = `ship-hp-${ownerId}`;
  }

  // 残 HP 比を塗りで示す三角の HP マーカー。
  public hpMarker(hp: number, maxHp: number): string {
    return triangleHpMarkerSvg(hp, maxHp);
  }

  // 進行方向へ回転させても崩れない HP 表現。後部が凹んだ鋭角矢尻の外形と、底辺からの塗り高さで
  // 残 HP 比を示す。isEnemy は中抜きスタイルを選ぶ。
  public headingHpMarker(hp: number, maxHp: number, isEnemy = false): string {
    // 塗りの上端は、底辺から矢尻の頂点までを残 HP 比で内分した高さ。
    const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
    const fillTopY = (21 - ratio * (21 - 1.5)).toFixed(2);
    const aria = `HP ${Math.max(0, hp)} / ${maxHp}`;
    if (isEnemy) {
      return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="${aria}">` +
        `<polygon points="${SHIP_ARROWHEAD_POINTS}" fill="none" stroke="currentColor" stroke-width="1.8"/>` +
        `</svg>`;
    }
    return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="${aria}">` +
      `<clipPath id="${this.clipId}"><rect x="0" y="${fillTopY}" width="24" height="24"/></clipPath>` +
      `<polygon points="${SHIP_ARROWHEAD_POINTS}" fill="currentColor" fill-opacity="1" clip-path="url(#${this.clipId})"/>` +
      `<polygon points="${SHIP_ARROWHEAD_POINTS}" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
      `</svg>`;
  }
}
