// ラグランジュ点を指す、実体を持たない被選択物。生成元が解いた時刻の位置を持ち、天体と同じ
// 名前空間の id と、マップのマーカーへ出す二行表記を答える。
import { lagrangeId, type LagrangePointNumber } from '../celestial/lagrange-id';
import type { Vec3 } from '../../math/vec3';
import type { MapVisibility, MapVisibilityPolicy } from '../map/visibility-policy';
import { bodySearchText } from '../pickable/body-search-text';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { MapPickable } from '../pickable/map-pickable';
import type { Player } from '../player/player';
import type { MarkerManager } from './marker-manager';

export class LagrangePointMarker implements MapPickable {
  public readonly kind = 'body';
  public readonly id: string;
  public readonly name: string;
  // 地点名を上、所属天体を下の行に置く二行表記。
  public readonly markerLabel: string;
  public readonly ownerName = null;
  public readonly mapTime = null;
  public readonly mapState = null;

  private pos: Vec3 | null = null;

  // 親天体と点番号で1つの地点が決まる。名前は所属天体を前に置き、一覧では親の直下に並ぶ。
  public constructor(
    public readonly parentId: string,
    parentName: string,
    public readonly point: LagrangePointNumber,
  ) {
    this.id = lagrangeId(parentId, point);
    this.name = `${parentName}-L${point}`;
    this.markerLabel = `L${point}\n${parentName}`;
  }

  // 今フレームの位置を記録する。求まらなかったフレームは null を渡す。
  public place(pos: Vec3 | null): void {
    this.pos = pos;
  }

  public get gone(): boolean { return this.pos === null; }

  // 生成元が解いた時刻の位置。
  public mapPosAt(): Vec3 | null { return this.pos; }

  // ラグランジュ点は天体と別の表示トグルを持つ。
  public mapVisibility(policy: MapVisibilityPolicy): MapVisibility { return policy.body(this.id); }
  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.id); }

  public listDetail(): string { return ''; }

  // 一覧の検索が照合する、自艦からの距離と中心天体の名前。
  public listSearchText(
    celestialSystem: CelestialSystem, activePlayer: Player | null, displayTime: number,
  ): string {
    return this.pos === null ? '' : bodySearchText(celestialSystem, this.pos, activePlayer, displayTime);
  }

  public listCounted(): boolean { return false; }
  public listPriority(): number { return 0; }
}
