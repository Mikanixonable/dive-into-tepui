// 1つのオブジェクトの軌道が中心天体の赤道面を横切る点(EqAN/EqDN)を指す、実体を持たない
// 被選択物。持ち主と中心天体を冠した呼称を答える。
import { ORBIT_ELEMENT_LABELS, type OrbitLabelSpec } from '../hud/orbit/orbit-labels';
import { ORBIT_POINT_GLYPH } from './marker-identity';
import { OrbitPointMarker } from './orbit-point-marker';
import type { Vec3 } from '../../math/vec3';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { ObjectCommands } from '../pickable/object-commands';
import type { PropertyRow } from '../hud/windows/property-window';

// 交点種別ごとの、マーカーのキーに使う接頭辞と、軌道要素としてのラベル。
const EQUATOR_NODE_LABELS = {
  ascending: { idPrefix: 'eqan', spec: ORBIT_ELEMENT_LABELS.eqAn, glyph: ORBIT_POINT_GLYPH.ascendingNode },
  descending: { idPrefix: 'eqdn', spec: ORBIT_ELEMENT_LABELS.eqDn, glyph: ORBIT_POINT_GLYPH.descendingNode },
} as const;

export class EquatorNodeMarker extends OrbitPointMarker {
  public readonly glyph = ORBIT_POINT_GLYPH.descendingNode;
  protected readonly markerGlyph: string;
  protected readonly markerClass = 'mk-node';
  public readonly markerLabel: string;

  private readonly spec: OrbitLabelSpec;
  private center: string | null = null;

  // ownerId は軌道の持ち主、node はこのマーカーが指す交点。持ち主ごとに昇交点・降交点を
  // 1つずつ作る。
  public constructor(ownerId: string, node: 'ascending' | 'descending') {
    super(`${EQUATOR_NODE_LABELS[node].idPrefix}-${ownerId}`);
    this.spec = EQUATOR_NODE_LABELS[node].spec;
    this.markerLabel = this.spec.short;
    this.markerGlyph = EQUATOR_NODE_LABELS[node].glyph;
  }

  // 今フレームの解を記録する。求まらなかったフレームはすべての引数に null を渡す。
  public place(pos: Vec3 | null, time: number | null, ownerName: string | null, centerName: string | null): void {
    this.placeSolution(pos, time, ownerName);
    this.center = centerName;
  }

  // 持ち主と中心天体を冠した呼称。解が無いフレームは空文字。
  public get name(): string {
    if (this.owner === null || this.center === null) return '';
    return `${this.owner}の${this.center}${this.spec.nameJa}`;
  }

  protected get headerLabel(): string { return `${this.center ?? ''}${this.spec.nameJa}`; }
  protected get headerSubLabel(): string { return this.spec.nameEn; }

  // 所属軌道・中心天体の名前・通過までの残り時間。
  public propertyRows(
    _commands: ObjectCommands, _celestialSystem: CelestialSystem, simTime: number,
  ): readonly PropertyRow[] {
    return [
      ...this.ownerRows(),
      { key: 'target', label: '対象', value: this.center ?? '対象' },
      ...this.passTimeRows(simTime),
    ];
  }
}
