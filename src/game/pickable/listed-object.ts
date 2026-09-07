// 軌道物体一覧と選択ウィジェットに並ぶ物体。自分がどの区画・どのジャンルへ出るか、行に何を
// 添えるか、検索に何を照合させるか、どの順に並ぶかを答える。
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { OrbitingObject } from '../dynamic/dynamic-entity/orbiting-object';
import type { PickCandidate } from './pick-candidate';
import type { MapListSection, ObjectPickerGenre } from './pickable-listing';

export interface ListedObject extends PickCandidate {
  // 軌道物体一覧のどの区画へ出すか。一覧に出さない対象は null。
  readonly listSection: MapListSection | null;
  // 選択ウィジェット(ObjectPicker)のどのジャンルへ出すか。出さない対象は null。
  readonly pickerGenre: ObjectPickerGenre | null;

  // 軌道物体一覧の行へ添える補助表示。
  listDetail(celestialBodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number): string;
  // 軌道物体一覧の検索が照合する文字列。行に出さない情報を含めてよい。
  listSearchText(celestialBodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number): string;
  // 区画見出しの内訳(接近 N・回収可 N)に数えるか。
  listCounted(viewer: OrbitingObject | null, displayTime: number): boolean;
  // 軌道物体一覧での表示順の優先度。小さいほど先に出る。
  listPriority(viewer: OrbitingObject | null): number;
}
