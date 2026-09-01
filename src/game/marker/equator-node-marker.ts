// 1つのオブジェクトの軌道が中心天体の赤道面を横切る点(EqAN/EqDN)を指す、実体を持たない
// 被選択物。生成元が解いた時刻の位置と通過時刻を持ち、所有者と中心天体を冠した呼称を答える。
import { MARKER_VISIBILITY, type MapVisibility } from '../map/visibility-policy';
import type { Vec3 } from '../../math/vec3';
import type { MapPickable } from '../pickable/map-pickable';
import type { MarkerManager } from './marker-manager';

// 交点種別ごとの、マーカーのキーに使う接頭辞・マーカーへ出す略称・呼称の末尾。
const EQUATOR_NODE_LABELS = {
  ascending: { idPrefix: 'eqan', markerLabel: 'EqAN', nameSuffix: '赤道昇交点' },
  descending: { idPrefix: 'eqdn', markerLabel: 'EqDN', nameSuffix: '赤道降交点' },
} as const;

export class EquatorNodeMarker implements MapPickable {
  public readonly kind = 'eqnode';
  public readonly id: string;
  public readonly markerLabel: string;
  public readonly mapState = null;

  private readonly nameSuffix: string;
  private pos: Vec3 | null = null;
  private time: number | null = null;
  private owner: string | null = null;
  private center: string | null = null;

  // ownerId は軌道の持ち主、node はこのマーカーが指す交点。持ち主ごとに昇交点・降交点を
  // 1つずつ作る。
  public constructor(ownerId: string, node: 'ascending' | 'descending') {
    this.id = `${EQUATOR_NODE_LABELS[node].idPrefix}-${ownerId}`;
    this.markerLabel = EQUATOR_NODE_LABELS[node].markerLabel;
    this.nameSuffix = EQUATOR_NODE_LABELS[node].nameSuffix;
  }

  // 今フレームの解を記録する。求まらなかったフレームはすべての引数に null を渡す。
  public place(pos: Vec3 | null, time: number | null, ownerName: string | null, centerName: string | null): void {
    this.pos = pos;
    this.time = time;
    this.owner = ownerName;
    this.center = centerName;
  }

  // 持ち主と中心天体を冠した呼称。解が無いフレームは空文字。
  public get name(): string {
    if (this.owner === null || this.center === null) return '';
    return `${this.owner}の${this.center}${this.nameSuffix}`;
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
