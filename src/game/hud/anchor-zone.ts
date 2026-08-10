// マップの座標系UIのうち「何に固定/追随するか」を選ばせるゾーン。上段は登録天体・自艦・
// 敵・基地・弾薬まで含む全候補から選ぶプルダウン(ObjectPicker)、下段はいまカメラがいる
// 系の天体だけに絞ったクイックボタン(SegmentedControl)。
import { Attractor } from '../../physics/attractor';
import { Ephemeris } from '../../physics/ephemeris';
import { primaryOf } from '../../physics/solar-system';
import { Vec3 } from '../../physics/vec3';
import { systemChainAt } from '../celestial/body-visibility';
import type { MapPickable } from '../map-pick';
import { SegmentedControl } from './buttons';
import { groupPickables, LAGRANGE_ID, lagrangeParentId } from './object-groups';
import { ObjectPicker, ObjectPickerGroup } from './object-picker';

const STYLE = `
#hud .hud-anchor-zone { display: flex; flex-direction: column; gap: 4px; }
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

  // hudRoot は ObjectPicker のポップアップの親、title はプルダウンの見出し。releaseLabel が
  // null なら「解除」の選択肢そのものを出さない(プルダウン先頭・クイックボタン先頭の両方)。
  constructor(hudRoot: HTMLElement, title: string, ephemeris: Ephemeris, private readonly releaseLabel: string | null) {
    ensureStyle();
    this.ephemeris = ephemeris;

    this.element = document.createElement('div');
    this.element.className = 'hud-anchor-zone';

    this.picker = new ObjectPicker<string | null>(hudRoot, title, (id) => this.onSelect?.(id));
    this.element.appendChild(this.picker.element);

    this.quick = new SegmentedControl<string | null>('', [], (id) => this.onSelect?.(id));
    this.element.appendChild(this.quick.element);
  }

  // 選べる対象の一覧を現在のマップ候補へ合わせる。releaseLabel があれば先頭に解除の選択肢を足す。
  setItems(pickables: readonly MapPickable[]): void {
    const groups: ObjectPickerGroup<string | null>[] = [
      ...(this.releaseLabel !== null ? [{ label: '', items: [[null, this.releaseLabel] as const] }] : []),
      ...groupPickables(this.ephemeris.registry, pickables),
    ];
    this.picker.setGroups(groups);
  }

  // クイックボタンを「いまカメラがいる系」の天体・衛星・ラグランジュ点へ合わせる。
  // 候補に無い id は出さない(押せてから拒否することになるため)。
  setNearby(cameraPos: Vec3, attractors: readonly Attractor[], pickables: readonly MapPickable[]): void {
    const registry = this.ephemeris.registry;
    const chain = systemChainAt(registry, cameraPos, attractors);
    const byId = new Map(pickables.map((p) => [p.id, p] as const));

    const bodyIds = chain.filter((id) => byId.has(id));
    // 系列に含まれる天体を親に持つ衛星を足す。
    const satelliteIds: string[] = [];
    for (const p of pickables) {
      if (p.kind !== 'body' || LAGRANGE_ID.test(p.id) || bodyIds.includes(p.id)) continue;
      const parent = registry[p.id] === undefined ? null : primaryOf(registry, p.id);
      if (parent !== null && bodyIds.includes(parent)) satelliteIds.push(p.id);
    }
    const baseIds = [...bodyIds, ...satelliteIds];

    const lagrangeIds: string[] = [];
    for (const p of pickables) {
      if (p.kind !== 'body' || !LAGRANGE_ID.test(p.id)) continue;
      if (baseIds.includes(lagrangeParentId(p.id))) lagrangeIds.push(p.id);
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
}
