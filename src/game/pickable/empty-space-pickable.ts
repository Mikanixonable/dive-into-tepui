// 何にも当たらなかったクリックが指す「宇宙空間」の被選択物。実体を持たず、原点を位置とする。
import { v3, type Vec3 } from '../../math/vec3';
import { MARKER_VISIBILITY, type MapVisibility } from '../map/visibility-policy';
import type { MapPickable } from './map-pickable';
import type { MarkerManager } from '../marker/marker-manager';

const ORIGIN = v3(0, 0, 0); // ECI [m]

export class EmptySpacePickable implements MapPickable {
  public readonly kind = 'empty-space';
  public readonly id = 'empty';
  public readonly name = '宇宙空間';
  public readonly ownerName = null;
  public readonly mapTime = null;
  public readonly mapState = null;
  public readonly gone = false;

  // 宇宙空間そのものを指すので、いつでも原点を返す。
  public mapPosAt(): Vec3 { return ORIGIN; }

  public mapVisibility(): MapVisibility { return MARKER_VISIBILITY; }
  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.id); }

  public listDetail(): string { return ''; }
  public listSearchText(): string { return ''; }
  public listCounted(): boolean { return false; }
  public listPriority(): number { return 0; }
}
