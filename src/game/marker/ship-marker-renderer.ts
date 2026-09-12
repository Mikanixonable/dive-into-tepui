import { EntityIdAllocator } from '../dynamic/dynamic-entity/entity-id';
import { SHIP_ARROWHEAD_POINTS, triangleHpMarkerSvg } from './marker-shapes';

const clipIdAllocator = new EntityIdAllocator('ship-hp-');

// 船体の HP 表現だけを担当する renderer。船の物理・部品構成は知らない。
export class ShipMarkerRenderer {
  private readonly clipId = clipIdAllocator.next();

  public hpMarker(hp: number, maxHp: number): string {
    return triangleHpMarkerSvg(hp, maxHp);
  }

  public headingHpMarker(hp: number, maxHp: number, isEnemy = false): string {
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
