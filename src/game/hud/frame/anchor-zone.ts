// マップの座標系UIのうち「何に固定/追随するか」を選ばせるゾーン。上段は登録天体・自艦・
// 敵・基地・弾薬まで含む全候補から選ぶプルダウン(ObjectPicker)、下段はいまカメラがいる
// 系の天体だけに絞ったクイックボタン(SegmentedControl)。
import { CelestialBodyId } from '../../../physics/celestial-body';
import { Ephemeris } from '../../../physics/ephemeris';
import { FRAME_ROLES } from '../../../physics/frame';
import type { MapPickable } from '../../map-pickable';
import { SegmentedControl } from '../widgets';
import { frameRoleAnchorId, frameRoleName } from './frame-labels';
import { groupPickables, LAGRANGE_ID, lagrangeParentId } from '../object-groups';
import { ObjectPicker, ObjectPickerGroup } from '../windows/object-picker';
import type { OverlayManager } from '../overlay-manager';

// プルダウン先頭に置く役割グループ。役割は毎フレーム対象へ解決されるので、乗り換え・付け替えを
// またいで選択が保たれる(MAP.md 3節)。
const ROLE_GROUP: ObjectPickerGroup<string | null> = {
  label: '役割',
  items: FRAME_ROLES.map((role) => [frameRoleAnchorId(role), frameRoleName(role)] as const),
};

const STYLE = `
#hud .hud-anchor-zone { display: flex; flex-direction: column; gap: var(--space-2); }
`;

let styleInjected = false;
// ゾーンのスタイルシートを document.head へ一度だけ挿入する。
function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export class AnchorZone {
  readonly element: HTMLElement;
  // null は「固定を解除」= releaseLabel が表す選択を表す。
  onSelect: ((id: string | null) => void) | null = null;

  private readonly picker: ObjectPicker<string | null>;
  private readonly quick: SegmentedControl<string | null>;
  private readonly ephemeris: Ephemeris;

  // popupRoot は ObjectPicker のポップアップの親、title はプルダウンの見出し。releaseLabel が
  // null なら「解除」の選択肢そのものを出さない(プルダウン先頭・クイックボタン先頭の両方)。
  constructor(
    popupRoot: HTMLElement, title: string, ephemeris: Ephemeris, private readonly releaseLabel: string | null,
    overlayManager: OverlayManager,
  ) {
    ensureStyle();
    this.ephemeris = ephemeris;

    this.element = document.createElement('div');
    this.element.className = 'hud-anchor-zone';

    this.picker = new ObjectPicker<string | null>(popupRoot, title, (id) => this.onSelect?.(id), overlayManager);
    this.element.appendChild(this.picker.element);

    this.quick = new SegmentedControl<string | null>('', [], (id) => this.onSelect?.(id));
    this.element.appendChild(this.quick.element);
  }

  // 選べる対象の一覧を現在のマップ候補へ合わせる。releaseLabel があれば先頭に解除の選択肢を足す。
  setItems(pickables: readonly MapPickable[]): void {
    const groups: ObjectPickerGroup<string | null>[] = [
      ...(this.releaseLabel !== null ? [{ label: '', items: [[null, this.releaseLabel] as const] }] : []),
      ROLE_GROUP,
      ...groupPickables(this.ephemeris.registry, pickables),
    ];
    this.picker.setGroups(groups);
  }

  // クイックボタンを、渡された系の天体列(+その衛星・ラグランジュ点)へ合わせる。
  // 候補に無い id は出さない(押せてから拒否することになるため)。
  setNearby(members: readonly CelestialBodyId[], pickables: readonly MapPickable[]): void {
    const byId = new Map(pickables.map((p) => [p.id, p] as const));

    const baseIds = members.filter((id) => byId.has(id));
    const baseIdSet = new Set(baseIds);

    const lagrangeIds: string[] = [];
    for (const p of pickables) {
      if (p.kind !== 'body' || !LAGRANGE_ID.test(p.id)) continue;
      if (baseIdSet.has(lagrangeParentId(p.id))) lagrangeIds.push(p.id);
    }

    const items: (readonly [string | null, string])[] = this.releaseLabel !== null ? [[null, '解除']] : [];
    for (const id of [...baseIds, ...lagrangeIds]) {
      const p = byId.get(id);
      if (p !== undefined) items.push([id, p.name]);
    }
    this.quick.setItems(items);
  }

  // 選択中の表示を合わせる。
  setSelected(id: string | null): void {
    this.picker.setSelected(id);
    this.quick.setSelected(id);
  }

  // 保持している ObjectPicker を片付ける。
  dispose(): void {
    this.picker.dispose();
  }
}
