// 自機軌道上の、ターゲットの軌道面に対する昇交点・降交点と、ターゲットへの再接近点を指す、
// 実体を持たない被選択物。生成元が解いた時刻の位置と通過時刻を持つ。
import { MARKER_VISIBILITY, type MapVisibility } from '../map/visibility-policy';
import type { Vec3 } from '../../math/vec3';
import type { MapPickable } from '../pickable/map-pickable';
import type { MarkerManager } from './marker-manager';

// 交点種別ごとの呼称と、マーカーへ出す略称。
const RELATIVE_NODE_LABELS = {
  an: { name: 'AN', markerLabel: 'AN' },
  dn: { name: 'DN', markerLabel: 'DN' },
  ca: { name: '再接近点', markerLabel: '再接近' },
} as const;

export class RelativeNodeMarker implements MapPickable {
  public readonly kind = 'relnode';
  public readonly id: string;
  public readonly name: string;
  public readonly markerLabel: string;
  public readonly mapState = null;

  private pos: Vec3 | null = null;
  private time: number | null = null;
  private owner: string | null = null;

  // node はこのマーカーが指す交点。昇交点・降交点・再接近点それぞれに1つずつ作る。
  public constructor(node: 'an' | 'dn' | 'ca') {
    this.id = `nav-${node}`;
    this.name = RELATIVE_NODE_LABELS[node].name;
    this.markerLabel = RELATIVE_NODE_LABELS[node].markerLabel;
  }

  // 今フレームの解を記録する。求まらなかったフレームは位置と時刻に null を渡す。
  public place(pos: Vec3 | null, time: number | null, ownerName: string | null): void {
    this.pos = pos;
    this.time = time;
    this.owner = ownerName;
  }

  public get gone(): boolean { return this.pos === null; }
  public get ownerName(): string | null { return this.owner; }
  public get mapTime(): number | null { return this.time; }

  // 生成元が解いた時刻の位置。
  public mapPosAt(): Vec3 | null { return this.pos; }

  public mapVisibility(): MapVisibility { return MARKER_VISIBILITY; }
  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.id); }

  public listDetail(): string { return ''; }
  public listSearchText(): string { return ''; }
  public listCounted(): boolean { return false; }
  public listPriority(): number { return 0; }
}
