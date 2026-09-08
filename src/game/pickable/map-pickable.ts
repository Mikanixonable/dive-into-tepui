// マップ上で掴める物体。候補に出る条件の自己申告と、左クリック・注視移動・視線判定への応答を
// 答える。
import type { Ray } from '../../math/ray';
import type { Vec3 } from '../../math/vec3';
import type { ControlSelection } from '../control-selection';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';
import type { MapVisibility, MapVisibilityPolicy } from '../map/visibility-policy';
import type { MarkerVisibility } from '../marker/marker-visibility';
import type { ObjectWindows } from './object-windows';
import type { PickCandidate } from './pick-candidate';

export interface MapPickable extends PickCandidate {
  // 天体に遮られている間は選べなくなるか。天体自身は遮蔽で候補から外さない
  // (公転・カメラ移動のたびに一覧の行が明滅するため)。
  readonly hiddenBehindBodies: boolean;
  // フォーカス中の惑星系に属するときだけ候補に出すか。
  readonly onlyInFocusedSystem: boolean;

  // 表示トグルによる可否。viewer は操作中の対象を例外扱いする判定に使う。
  mapVisibility(policy: MapVisibilityPolicy, viewer: OrbitingObject | null): MapVisibility;
  // 直前のフレームで画面にマーカーが出ていたか。出ていない対象はマップ上で掴めない。
  shownOnMap(markers: MarkerVisibility): boolean;

  // マップの左クリックで選ばれたときの振る舞い。左クリックで掴めない対象は null。
  readonly onMapSelect: ((windows: ObjectWindows, clientX: number, clientY: number) => void) | null;
  // マップの注視点が自分へ移ったときに、注視の移動に加えて起きること。何も起きない対象は null。
  readonly onMapFocus: ((controlSelection: ControlSelection) => void) | null;

  // 視線が、pos に描かれているこの対象の本体へ当たるか。pos は posAt が答えた、いま
  // 描かれている位置。本体を持たず、マーカーだけで示される対象は常に false。
  hitBodyByRay(ray: Ray, pos: Vec3): boolean;
}
