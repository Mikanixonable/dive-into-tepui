import { len, sub, type Vec3 } from '../../physics/vec3';
import * as C from '../const';
import { fmtMarkerDist } from '../hud/utils';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import { ENTITY_GLYPH } from '../marker/marker-glyphs';
import { currentThemePalette } from '../theme';

// pos/vel は機体メッシュと同じ表示時刻の状態(displayState 経由)を使う。role がターゲットで
// なければ通常の敵マーカーになる。sym は overviewMode に応じて呼び出し側が用意した HP 表示。
export function buildEnemyMarkerItem(
  name: string, role: 'none' | 'primary', viewerPos: Vec3, pos: Vec3, vel: Vec3, overviewMode: boolean, sym: string,
): GroupedMarkerItem {
  // 距離は優先度(近いほど高)とラベル表示の両方に使う
  const dist = len(sub(pos, viewerPos));
  // 代表選出の優先度: ターゲット > 距離が近い順 (天体 > 船・エンティティ)
  const priority = role === 'primary' ? C.MARKER_PRIORITY.PRIMARY_TARGET : C.MARKER_PRIORITY.ENEMY - dist / 1e9;
  return {
    key: `enemy-${name}`,
    cls: role === 'primary' ? 'mk-enemy mk-target' : 'mk-enemy',
    sym,
    pos,
    vel,
    priority,
    name,
    detail: overviewMode ? '' : fmtMarkerDist(dist),
    // 敵本体・距離ラベル・画面外方位マーカーは同じ色で統一する。ターゲット中は第二アクセントカラーで強調する。
    bearingColor: role === 'primary' ? currentThemePalette().signal : C.COLOR_MARKER_ENEMY,
    bearingSym: ENTITY_GLYPH.enemyShip,
    bearingClass: 'mk-dir mk-bearing-triangle',
    color: role === 'primary' ? currentThemePalette().signal : C.COLOR_MARKER_ENEMY,
    symMarkup: true,
  };
}
