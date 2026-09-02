// 計画軌道の近点・遠点を指す、実体を持たない被選択物。中心天体に応じた呼称(近地点/近月点…)
// とマーカー用の略称を答え、その天体の表面からの高度を示す。
import { getApsisLabelSpec, type OrbitLabelSpec } from '../hud/orbit/orbit-labels';
import { fmtDist } from '../hud/utils';
import { len, sub, type Vec3 } from '../../math/vec3';
import { ORBIT_POINT_GLYPH } from './marker-identity';
import { OrbitPointMarker } from './orbit-point-marker';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { MapCommands } from '../pickable/map-commands';
import type { PropertyRow } from '../hud/windows/property-window';

export class ApsisMarker extends OrbitPointMarker {
  public readonly mapGlyph = ORBIT_POINT_GLYPH.apsis;
  protected readonly markerGlyph = ORBIT_POINT_GLYPH.apsis;
  protected readonly markerClass = 'mk-apsis';

  private centerId: string | null = null;

  // apsis はこのマーカーが指す極値。近点・遠点それぞれに1つずつ作る。
  public constructor(private readonly apsis: 'pe' | 'ap') {
    super(apsis === 'pe' ? 'apsisPe' : 'apsisAp');
  }

  // 今フレームの解を記録する。求まらなかったフレームはすべての引数に null を渡す。
  public place(pos: Vec3 | null, time: number | null, centerId: string | null, ownerName: string | null): void {
    this.placeSolution(pos, time, ownerName);
    this.centerId = centerId;
  }

  public get name(): string { return this.spec.nameJa; }
  public get markerLabel(): string { return this.spec.short; }
  protected get headerLabel(): string { return this.spec.nameJa; }
  protected get headerSubLabel(): string { return this.spec.nameEn; }

  // 中心天体に応じた呼称。中心が定まらないフレームは総称(近点/遠点)になる。
  private get spec(): OrbitLabelSpec { return getApsisLabelSpec(this.apsis, this.centerId ?? ''); }

  // 所属軌道・中心天体の表面からの高度・通過までの残り時間。位置が解けていなければ行は無く、
  // 中心天体が引けないフレームは高度が落ちる。
  public mapPropertyRows(
    _commands: MapCommands, celestialSystem: CelestialSystem, simTime: number,
  ): readonly PropertyRow[] {
    const pos = this.pos;
    if (pos === null) return [];
    // 高度の基準は、place で受け取った中心天体の表面。
    const center = this.centerId === null ? null : (celestialSystem.find(this.centerId)?.motion ?? null);
    const altRows: PropertyRow[] = center === null ? [] : [{
      key: 'alt',
      label: '高度',
      value: fmtDist(len(sub(pos, center.positionAt(simTime))) - center.def.radius),
    }];
    return [...this.ownerRows(), ...altRows, ...this.passTimeRows(simTime)];
  }
}
