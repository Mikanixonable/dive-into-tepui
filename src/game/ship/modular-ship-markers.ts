// モジュール船が画面マーカー・一覧へ提示する項目を組み立てる。
import { len, sub, type Vec3 } from '../../math/vec3';
import type { ViewMode } from '../view/view-mode';
import type { DynamicEntityKind } from '../dynamic/entity/entity-kind';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import { DIRECTION_GLYPH, COLOR_MARKER_ALLY } from '../marker/marker-identity';
import { MARKER_PRIORITY } from '../marker/marker-priority';
import { baseMarkerSvg } from '../marker/marker-shapes';
import type { ShipRole } from './ship-assembly-types';

const ALLY_BEARING_MAX_DISTANCE = 20e3; // 味方機の画面外方位マーカーを表示する上限距離 [m]

// マーカー項目の組み立てが読む、艦の面。
interface ModularShipMarkerPort {
  readonly id: string;
  readonly name: string;
  readonly mapKind: DynamicEntityKind;
  readonly markerKey: string;
  readonly capabilities: { readonly role: ShipRole };
  hpMarkerSvg(): string;
  headingHpMarkerSvg(): string;
}

// 画面マーカー・一覧に出すこの艦の項目。isActive はマップ上で自艦と僚艦を塗り分ける
// ための操作対象フラグ。
export function modularShipMarkerItem(
  ship: ModularShipMarkerPort, viewerPos: Vec3 | null, pos: Vec3, vel: Vec3,
  view: ViewMode, isActive: boolean,
): GroupedMarkerItem {
  const distance = viewerPos === null ? null : len(sub(pos, viewerPos));
  const isBaseRole = ship.capabilities.role === 'base';
  return {
    key: ship.markerKey,
    kind: isBaseRole ? 'base' : ship.mapKind,
    cls: isBaseRole ? 'mk-base' : (isActive ? 'mk-self' : 'mk-ally'),
    sym: isBaseRole
      ? baseMarkerSvg() : (view === 'map' ? ship.headingHpMarkerSvg() : ship.hpMarkerSvg()),
    pos,
    vel,
    // 視点が無いフレームは距離を順位へ持ち込まず、全対象を同じ遠さとして扱う。
    priority: isBaseRole
      ? MARKER_PRIORITY.BASE - (distance ?? 0) / 1e9
      : MARKER_PRIORITY.PLAYER,
    name: ship.name,
    // 遠距離では画面外方位マーカーを畳み、密集を抑える。
    bearing: {
      color: COLOR_MARKER_ALLY,
      sym: DIRECTION_GLYPH.allyBearing,
      cls: 'mk-dir mk-ally-dir',
      visible: distance !== null && distance <= ALLY_BEARING_MAX_DISTANCE,
      clustered: true,
    },
    color: isActive ? 'var(--color-primary)' : COLOR_MARKER_ALLY,
    symMarkup: true,
  };
}
