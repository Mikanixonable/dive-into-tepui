// 自機軌道上の、ターゲットの軌道面に対する昇交点・降交点と、ターゲットへの再接近点を指す、
// 実体を持たない被選択物。
import { ORBIT_ELEMENT_LABELS, type OrbitLabelSpec } from '../hud/orbit/orbit-labels';
import { ORBIT_POINT_GLYPH } from './marker-identity';
import { OrbitPointMarker } from './orbit-point-marker';
import type { Vec3 } from '../../math/vec3';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { MapCommands } from '../pickable/map-commands';
import type { PropertyRow } from '../hud/windows/property-window';

// 交点種別ごとの、一覧やマーカーで名乗る呼称と、軌道要素としてのラベル。
const RELATIVE_NODE_LABELS = {
  an: { name: 'AN', spec: ORBIT_ELEMENT_LABELS.an, glyph: ORBIT_POINT_GLYPH.ascendingNode },
  dn: { name: 'DN', spec: ORBIT_ELEMENT_LABELS.dn, glyph: ORBIT_POINT_GLYPH.descendingNode },
  ca: { name: '再接近点', spec: ORBIT_ELEMENT_LABELS.ca, glyph: ORBIT_POINT_GLYPH.closestApproach },
} as const;

export class RelativeNodeMarker extends OrbitPointMarker {
  public readonly mapGlyph = ORBIT_POINT_GLYPH.ascendingNode;
  protected readonly markerGlyph: string;
  protected readonly markerClass = 'mk-node';
  public readonly markerLabel: string;
  public readonly name: string;

  private readonly spec: OrbitLabelSpec;
  // 交点を定める相手(航法ターゲット)の表示名。
  private targetName: string | null = null;

  // node はこのマーカーが指す交点。昇交点・降交点・再接近点それぞれに1つずつ作る。
  public constructor(node: 'an' | 'dn' | 'ca') {
    super(`nav-${node}`);
    this.name = RELATIVE_NODE_LABELS[node].name;
    this.spec = RELATIVE_NODE_LABELS[node].spec;
    this.markerLabel = this.spec.short;
    this.markerGlyph = RELATIVE_NODE_LABELS[node].glyph;
  }

  // 今フレームの解を記録する。求まらなかったフレームは位置と時刻に null を渡す。
  public place(pos: Vec3 | null, time: number | null, ownerName: string | null, targetName: string | null): void {
    this.placeSolution(pos, time, ownerName);
    this.targetName = targetName;
  }

  protected get headerLabel(): string { return this.spec.nameJa; }
  protected get headerSubLabel(): string { return this.spec.nameEn; }

  // 所属軌道・交点を定める相手の名前・通過までの残り時間。
  public mapPropertyRows(
    _commands: MapCommands, _celestialSystem: CelestialSystem, simTime: number,
  ): readonly PropertyRow[] {
    return [
      ...this.ownerRows(),
      { key: 'target', label: '対象', value: this.targetName ?? '対象' },
      ...this.passTimeRows(simTime),
    ];
  }
}
