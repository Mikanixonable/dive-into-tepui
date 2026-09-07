// ListedObject の列を、選択ウィジェット(ObjectPicker)向けのジャンル別グループへ組む純関数。
// どのジャンルへ入るかは候補自身(pickerGenre)が答えるので、ここは並べ替えと空グループの除去を行う。
import type { CelestialSystem } from '../celestial/celestial-system';
import type { ListedObject } from '../pickable/listed-object';

import type { ObjectPickerGroup } from './windows/object-picker';
import { OBJECT_PICKER_GENRES, type ObjectPickerGenre } from '../pickable/pickable-listing';

// items をジャンル別にグループ分けする。値は ListedObject.id。空のグループは返さない。
export function groupPickables(
  celestialSystem: CelestialSystem, items: readonly ListedObject[], includeAllCelestialBodies = false,
): readonly ObjectPickerGroup<string>[] {
  const byGenre = new Map<ObjectPickerGenre, [string, string][]>();
  const shownIds = new Set<string>();
  // ジャンルのグループへ [id, name] を積む(未登場のジャンルなら新規に作る)。
  const push = (genre: ObjectPickerGenre, id: string, name: string): void => {
    const list = byGenre.get(genre);
    if (list) list.push([id, name]); else byGenre.set(genre, [[id, name]]);
  };

  for (const item of items) {
    shownIds.add(item.id);
    if (item.pickerGenre !== null) push(item.pickerGenre, item.id, item.name);
  }

  // includeAllCelestialBodies が true なら「表示中の候補」に限らず、表示設定で
  // 除外された天体も含めて登録済み天体を全件補う。
  if (includeAllCelestialBodies) {
    for (const body of celestialSystem.entities) {
      if (shownIds.has(body.id) || body.pickerGenre === null) continue;
      push(body.pickerGenre, body.id, body.name);
    }
  }

  return OBJECT_PICKER_GENRES
    .map((label) => ({ label, items: byGenre.get(label) ?? [] }))
    .filter((g) => g.items.length > 0);
}
