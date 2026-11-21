// 軌道物体パネルと選択ウィジェットに並ぶオブジェクト。所属する区画・ジャンル、表示テキスト、
// 検索照合文字列の情報を提供する。
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';
import type { PickCandidate } from './pick-candidate';
import type { MapListSection, ObjectPickerGenre } from './pickable-listing';

export interface ListedObject extends PickCandidate {
  // 軌道物体パネルでどの種類として扱うか。パネルに出さない対象は null。
  readonly listSection: MapListSection | null;
  // 選択ウィジェット(ObjectPicker)のどのジャンルへ出すか。出さない対象は null。
  readonly pickerGenre: ObjectPickerGenre | null;

  // 軌道物体パネルの札と検索の行へ添える補助表示。
  listDetail(celestialBodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number): string;
  // 軌道物体パネルの検索が照合する文字列。行に出さない情報を含めてよい。
  listSearchText(celestialBodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number): string;
  // 状況の内訳に数えるか(敵は接近中、弾薬・RCS燃料は回収圏内)。
  listCounted(viewer: OrbitingObject | null, displayTime: number): boolean;
}
