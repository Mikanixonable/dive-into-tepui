// 実体そのものの位置を指すマーカー1つぶん。表示名と自機からの距離をラベルに出し、
// マップビューでは進行方向を向く ▲ に、戦闘ビューでは種別ごとの字形に切り替える。
// 戦闘ビューで画面外へ出た対象には、画面端の方位矢印を添える(マップビューでは対象が
// 俯瞰に収まっているので添えない)。
import { Vec3, len, sub } from '../../physics/vec3';
import { fmtMarkerDist } from '../hud/utils';
import type { MarkerManager } from './marker-manager';
import { DIRECTION_GLYPH, ENTITY_GLYPH } from './marker-glyphs';
import type { ProjectFn, ScaleFn } from '../camera/camera-system';
import type { MapVisibility } from '../celestial/map-visibility';
import type { GameEntity } from '../game-entity/game-entity';

// 画面外方位矢印の不透明度。実位置マーカーより控えめに出す。
const BEARING_OPACITY = 0.9;

export class EntityMarker {
  private readonly key: string;
  private readonly bearingKey: string;

  // className はマーカーの DOM クラス、combatGlyph は戦闘ビューで出す字形。
  constructor(
    private readonly owner: GameEntity,
    private readonly markerManager: MarkerManager,
    private readonly className: string,
    private readonly combatGlyph: string,
  ) {
    this.key = `entity-${owner.id}`;
    this.bearingKey = `entity-${owner.id}-bearing`;
  }

  // displayTime の位置へマーカーを置く。表示期間外・死亡・visibility が選択不可としたものは
  // 隠す。viewerPos があればラベルにそこからの距離を添える。
  sync(
    project: ProjectFn, scale: ScaleFn, displayTime: number, overviewMode: boolean,
    viewerPos: Vec3 | null, visibility: MapVisibility | null,
  ): void {
    const state = this.owner.alive ? this.owner.displayState(displayTime) : null;
    if (!state || (visibility && !visibility.pickable)) {
      this.hide();
      return;
    }
    const label = viewerPos
      ? `${this.owner.name} ${fmtMarkerDist(len(sub(state.r, viewerPos)))}`
      : this.owner.name;
    const shownLabel = visibility?.label === false ? '' : label;
    const p = project(state.r);
    if (overviewMode) {
      this.markerManager.set(
        this.key, this.className, visibility?.icon === false ? '' : ENTITY_GLYPH.ship,
        p.x, p.y, p.front, shownLabel, 1, undefined,
        this.markerManager.headingRotationDeg(state.r, state.v, project, scale),
      );
      this.markerManager.hide(this.bearingKey);
      return;
    }
    this.markerManager.set(this.key, this.className, this.combatGlyph, p.x, p.y, p.front, shownLabel);
    this.markerManager.setBearing(
      this.bearingKey, `${this.className} mk-bearing-triangle`, DIRECTION_GLYPH.bearing,
      p, shownLabel, BEARING_OPACITY,
    );
  }

  // マーカーと方位矢印を隠す。
  hide(): void {
    this.markerManager.hide(this.key);
    this.markerManager.hide(this.bearingKey);
  }

  // マーカー要素ごと取り除く。
  dispose(): void {
    this.markerManager.remove(this.key);
    this.markerManager.remove(this.bearingKey);
  }
}
