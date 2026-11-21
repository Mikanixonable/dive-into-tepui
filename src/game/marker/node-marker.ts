// 軌道の交点を指すマーカーの共通実装。赤道面との交点(EquatorNodeMarker)と
// ターゲット相対の交点(RelativeNodeMarker)は、ラベル表・呼称の組み方以外
// 同じ形なので、ここへ畳み込んでいる。
import { ORBIT_ELEMENT_LABELS, type OrbitLabelSpec } from '../hud/orbit/orbit-labels';
import { ORBIT_POINT_GLYPH } from './marker-identity';
import { MARKER_PRIORITY } from './marker-priority';
import { OrbitPointMarker } from './orbit-point-marker';
import type { Vec3 } from '../../math/vec3';
import type { PropertyRow } from '../../hud-kit/windows/property-window-content';
import type { OrbitingObject } from '../dynamic/entity/orbiting-object';
import type { CelestialBodies } from '../celestial/celestial-bodies';

// 種別ごとのラベル・字形を持つ交点マーカーの共通部。partnerName は
// 交点を定める相手(赤道なら中心天体、相対点なら航法ターゲット)の表示名。
abstract class NodeMarker extends OrbitPointMarker {
  public readonly glyph: string;
  protected readonly markerClass = 'mk-node';
  protected readonly markerPriority = MARKER_PRIORITY.ORBITAL_NODE;
  public readonly markerLabel: string;

  protected readonly spec: OrbitLabelSpec;
  protected partnerName: string | null = null;

  protected constructor(
    id: string,
    node: { readonly spec: OrbitLabelSpec; readonly glyph: string },
  ) {
    super(id);
    this.spec = node.spec;
    this.markerLabel = this.spec.short;
    this.glyph = node.glyph;
  }

  // 今フレームの解を記録する。求まらなかったフレームはすべての引数に null を渡す。
  public place(pos: Vec3 | null, time: number | null, ownerName: string | null, partnerName: string | null): void {
    this.placeSolution(pos, time, ownerName);
    this.partnerName = partnerName;
  }

  protected get headerLabel(): string { return `${this.headerPrefix ?? ''}${this.spec.nameJa}`; }
  protected get headerSubLabel(): string { return this.spec.nameEn; }
  // 見出しの先頭に置く相手名。相手を冠する種別だけが返し、既定は空。
  protected get headerPrefix(): string | null { return null; }

  // 所属軌道・交点を定める相手の名前・通過までの残り時間。
  public propertyRows(
    _celestialBodies: CelestialBodies, _viewer: OrbitingObject | null, simTime: number,
  ): readonly PropertyRow[] {
    return [
      ...this.ownerRows(),
      { key: 'target', label: '対象', value: this.partnerName ?? '対象', presentation: 'major' },
      ...this.passTimeRows(simTime),
    ];
  }
}

// 交点種別ごとの、マーカーのキーに使う接頭辞と、軌道要素としてのラベル。
const EQUATOR_NODE_LABELS = {
  ascending: { idPrefix: 'eqan', spec: ORBIT_ELEMENT_LABELS.eqAn, glyph: ORBIT_POINT_GLYPH.ascendingNode },
  descending: { idPrefix: 'eqdn', spec: ORBIT_ELEMENT_LABELS.eqDn, glyph: ORBIT_POINT_GLYPH.descendingNode },
} as const;

// 1つのオブジェクトの軌道が中心天体の赤道面を横切る点(EqAN/EqDN)を指す、実体を持たない
// 被選択物。所属と中心天体を含む呼称を提供する。
export class EquatorNodeMarker extends NodeMarker {
  // ownerId は軌道の持ち主、node はこのマーカーが指す交点。持ち主ごとに昇交点・降交点を
  // 1つずつ作る。
  public constructor(ownerId: string, node: 'ascending' | 'descending') {
    super(`${EQUATOR_NODE_LABELS[node].idPrefix}-${ownerId}`, EQUATOR_NODE_LABELS[node]);
  }

  // 持ち主と中心天体を冠した呼称。解が無いフレームは空文字。
  public get name(): string {
    if (this.owner === null || this.partnerName === null) return '';
    return `${this.owner}の${this.partnerName}${this.spec.nameJa}`;
  }

  protected get headerPrefix(): string | null { return this.partnerName; }
}

// 交点種別ごとの、一覧やマーカーで表示する呼称と、軌道要素としてのラベル。
const RELATIVE_NODE_LABELS = {
  an: { name: 'AN', spec: ORBIT_ELEMENT_LABELS.an, glyph: ORBIT_POINT_GLYPH.ascendingNode },
  dn: { name: 'DN', spec: ORBIT_ELEMENT_LABELS.dn, glyph: ORBIT_POINT_GLYPH.descendingNode },
  ca: { name: '再接近点', spec: ORBIT_ELEMENT_LABELS.ca, glyph: ORBIT_POINT_GLYPH.closestApproach },
} as const;

// 自機軌道上の、ターゲットの軌道面に対する昇交点・降交点と、ターゲットへの再接近点を指す、
// 実体を持たない被選択物。
export class RelativeNodeMarker extends NodeMarker {
  public readonly name: string;

  // node はこのマーカーが指す交点。昇交点・降交点・再接近点それぞれに1つずつ作る。
  public constructor(node: 'an' | 'dn' | 'ca') {
    super(`nav-${node}`, RELATIVE_NODE_LABELS[node]);
    this.name = RELATIVE_NODE_LABELS[node].name;
  }
}
