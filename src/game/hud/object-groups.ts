// ListedObject の列を、選択ウィジェット(ObjectPicker)向けのジャンル別グループへ組む純関数。
// どのジャンルへ入るかは候補自身(pickerGenre)が答えるので、ここは並べ替えと空グループの除去を行う。
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ObjectPickerGroup } from './windows/object-picker';
import { BODY_PICKER_GENRES, OBJECT_PICKER_GENRES, type ObjectPickerGenre } from '../pickable/pickable-listing';
import type { ListedObject } from '../pickable/listed-object';

// items をジャンル別にグループ分けする。値は ListedObject.id。空のグループは返さない。
export function groupPickables(
  celestialBodies: CelestialBodies, items: readonly ListedObject[], includeAllCelestialBodies = false,
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
    for (const motion of celestialBodies.celestialMotions) {
      const bodyClass = celestialBodies.bodyClassOf(motion.id);
      if (shownIds.has(motion.id) || bodyClass === null) continue;
      push(BODY_PICKER_GENRES[bodyClass], motion.id, celestialBodies.nameOf(motion.id));
    }
  }

  return OBJECT_PICKER_GENRES
    .map((label) => ({ label, items: byGenre.get(label) ?? [] }))
    .filter((g) => g.items.length > 0);
}
