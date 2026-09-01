// MapPickable の列を、選択ウィジェット(ObjectPicker)向けのジャンル別グループへ組む純関数。
// マーカー(近地点/遠地点・相対AN/DN・赤道昇降交点・空クリック)はオブジェクトではないので出さない。
import { isLagrangeId } from '../celestial/lagrange-id';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { MapPickable } from '../pickable/map-pickable';
import type { ObjectPickerGroup } from './windows/object-picker';

const GROUP_LABELS = ['恒星', '惑星', '準惑星', '衛星', '小天体', 'ラグランジュ点', '自艦', '敵', '基地', '弾薬', 'RCS燃料'] as const;

// items をジャンル別にグループ分けする。値は MapPickable.id。空のグループは返さない。
export function groupPickables(
  celestialSystem: CelestialSystem, items: readonly MapPickable[], includeAllCelestialBodies = false,
): readonly ObjectPickerGroup<string>[] {
  const byLabel = new Map<typeof GROUP_LABELS[number], [string, string][]>();
  const bodyIds = new Set<string>();
  // label のグループへ [id, name] を積む(未登場のラベルなら新規に作る)。
  const push = (label: typeof GROUP_LABELS[number], id: string, name: string): void => {
    const list = byLabel.get(label);
    if (list) list.push([id, name]); else byLabel.set(label, [[id, name]]);
  };

  // 'body' はさらにラグランジュ点か CelestialClass かで分ける。マーカー由来の kind は素通りする。
  for (const item of items) {
    switch (item.kind) {
      case 'body':
        bodyIds.add(item.id);
        if (isLagrangeId(item.id)) { push('ラグランジュ点', item.id, item.name); break; }
        switch (celestialSystem.entityOf(item.id).bodyClass) {
          case 'star': push('恒星', item.id, item.name); break;
          case 'planet': push('惑星', item.id, item.name); break;
          case 'dwarf': push('準惑星', item.id, item.name); break;
          case 'satellite': push('衛星', item.id, item.name); break;
          case 'smallBody': push('小天体', item.id, item.name); break;
        }
        break;
      case 'player': push('自艦', item.id, item.name); break;
      case 'ship': push('敵', item.id, item.name); break;
      case 'base': push('基地', item.id, item.name); break;
      case 'ammo': push('弾薬', item.id, item.name); break;
      case 'fuel': push('RCS燃料', item.id, item.name); break;
      case 'apsis': case 'relnode': case 'eqnode': case 'empty-space': break;
    }
  }

  // includeAllCelestialBodies が true なら「表示中の候補」に限らず、表示設定で
  // 除外された天体も含めて登録済み天体を全件補う。
  if (includeAllCelestialBodies) {
    for (const body of celestialSystem.entities) {
      if (bodyIds.has(body.id)) continue;
      switch (body.bodyClass) {
        case 'star': push('恒星', body.id, body.name); break;
        case 'planet': push('惑星', body.id, body.name); break;
        case 'dwarf': push('準惑星', body.id, body.name); break;
        case 'satellite': push('衛星', body.id, body.name); break;
        case 'smallBody': push('小天体', body.id, body.name); break;
      }
    }
  }

  return GROUP_LABELS
    .map((label) => ({ label, items: byLabel.get(label) ?? [] }))
    .filter((g) => g.items.length > 0);
}
