// マップ一覧に載せる対象の表示区分と検索情報を定める。
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { OrbitingObject } from '../dynamic/entity/orbiting-object';
import type { PickCandidate } from './pick-candidate';
import type { MapListSection, ObjectPickerGenre } from './pickable-listing';

export interface ListedObject extends PickCandidate {
  // マップ一覧で扱う対象の区分。表示しない対象は null。
  readonly listSection: MapListSection | null;
  // 選択ウィジェット(ObjectPicker)のどのジャンルへ出すか。出さない対象は null。
  readonly pickerGenre: ObjectPickerGenre | null;

  // 対象名へ添える詳細表示。
  listDetail(celestialBodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number): string;
  // 検索に使う文字列。対象名に出さない語も含められる。
  listSearchText(celestialBodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number): string;
  // 状況の内訳に加える対象かを返す。
  listCounted(viewer: OrbitingObject | null, displayTime: number): boolean;
}
