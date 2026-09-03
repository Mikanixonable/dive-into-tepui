// マップの座標系UIのうち「何に固定/追随するか」を選ばせるゾーン。上段は登録天体・自艦・
// 敵・基地・弾薬まで含む全候補から選ぶプルダウン(ObjectPicker)、下段はいまカメラがいる
// 系の天体だけに絞ったクイックボタン(SegmentedControl)。
import { FRAME_ROLES, frameRoleAnchorId } from '../../../physics/frame';
import type { CelestialSystem } from '../../celestial/celestial-system';
import type { ObjectPickable } from '../../pickable/object-pickable';
import { SegmentedControl } from '../../../hud/widgets';
import { injectOnce } from '../../../hud/widgets/inject-style';
import { frameRoleName } from './frame-labels';
import { LagrangePointMarker } from '../../marker/lagrange-point-marker';
import { groupPickables } from '../object-groups';
import { ObjectPicker, ObjectPickerGroup } from '../windows/object-picker';
import type { OverlayManager } from '../../../hud/overlay-manager';

// プルダウン先頭に置く役割グループ。役割は毎フレーム対象へ解決されるので、乗り換え・付け替えを
// またいで選択が保たれる(MAP.md 3節)。
const ROLE_GROUP: ObjectPickerGroup<string | null> = {
  label: '役割',
  items: FRAME_ROLES.map((role) => [frameRoleAnchorId(role), frameRoleName(role)] as const),
};

const STYLE = `
#hud .hud-anchor-zone { display: flex; flex-direction: column; gap: var(--space-2); }
`;

export class AnchorZone {
  public readonly element: HTMLElement;
  // null は「固定を解除」= releaseLabel が表す選択を表す。
  public onSelect: ((id: string | null) => void) | null = null;

  private readonly picker: ObjectPicker<string | null>;
  private readonly quick: SegmentedControl<string | null>;

  // popupRoot は ObjectPicker のポップアップの親、title はプルダウンの見出し。releaseLabel が
  // null なら「解除」の選択肢そのものを出さない(プルダウン先頭・クイックボタン先頭の両方)。
  public constructor(
    popupRoot: HTMLElement, title: string, private readonly celestialSystem: CelestialSystem,
    private readonly releaseLabel: string | null,
    overlayManager: OverlayManager,
  ) {
    injectOnce('anchor-zone', STYLE);

    this.element = document.createElement('div');
    this.element.className = 'hud-anchor-zone';

    this.picker = new ObjectPicker<string | null>(popupRoot, title, (id) => this.onSelect?.(id), overlayManager);
    this.element.appendChild(this.picker.element);

    this.quick = new SegmentedControl<string | null>('', [], (id) => this.onSelect?.(id));
    this.element.appendChild(this.quick.element);
  }

  // 選べる対象の一覧を現在のマップ候補へ合わせる。releaseLabel があれば先頭に解除の選択肢を足す。
  public setItems(pickables: readonly ObjectPickable[], includeAllCelestialBodies = false): void {
    const groups: ObjectPickerGroup<string | null>[] = [
      ...(this.releaseLabel !== null ? [{ label: '', items: [[null, this.releaseLabel] as const] }] : []),
      ROLE_GROUP,
      ...groupPickables(this.celestialSystem, pickables, includeAllCelestialBodies),
    ];
    this.picker.setGroups(groups);
  }

  // クイックボタンを、渡された系の天体列(+その衛星・ラグランジュ点)へ合わせる。
  // 候補に無い id は出さない(押せてから拒否することになるため)。
  public setNearby(members: readonly string[], pickables: readonly ObjectPickable[]): void {
    const byId = new Map(pickables.map((p) => [p.id, p] as const));

    // 渡された系メンバーのうち、実際に選べる候補にあるものだけへ絞る。
    const baseIds = members.filter((id) => byId.has(id));
    const baseIdSet = new Set(baseIds);

    // 絞った天体を親に持つラグランジュ点も、クイックボタンの対象へ加える。
    const lagrangeIds: string[] = [];
    for (const p of pickables) {
      if (!(p instanceof LagrangePointMarker)) continue;
      if (baseIdSet.has(p.parentId)) lagrangeIds.push(p.id);
    }

    // 解除の選択肢(あれば)を先頭に、天体本体・ラグランジュ点の順で並べる。
    const items: (readonly [string | null, string])[] = this.releaseLabel !== null ? [[null, '解除']] : [];
    for (const id of [...baseIds, ...lagrangeIds]) {
      const p = byId.get(id);
      if (p !== undefined) items.push([id, p.name]);
    }
    this.quick.setItems(items);
  }

  // 選択中の表示を合わせる。
  public setSelected(id: string | null): void {
    this.picker.setSelected(id);
    this.quick.setSelected(id);
  }

  // 保持している ObjectPicker を片付ける。
  public dispose(): void {
    this.picker.dispose();
  }
}
