// 座標系(ReferenceFrame)を選ばせるコントロール。ReferenceFrame は「中心天体 × 回転の有無」の
// 直積(physics/frame.ts)なので、UI もその形に合わせて天体選択と慣性/回転の2段に分ける —
// 直積を展開した一覧にすると登録天体の2倍近い項目が1列に並ぶ。
import { ReferenceFrame } from '../../physics/frame';
import { Attractor, AttractorId } from '../../physics/attractor';
import { primaryOf } from '../../physics/solar-system';
import type { Ephemeris } from '../../physics/ephemeris';
import { bodyClassOf, BodyClass } from '../celestial/body-class';
import { celestialBodyName } from './frame-labels';
import { BodyPicker, BodyPickerGroup } from './body-picker';
import { SegmentedControl } from './buttons';

type RotationMode = 'inertial' | 'rotating';

const ROTATION_ITEMS: readonly (readonly [RotationMode, string])[] = [
  ['inertial', '慣性'],
  ['rotating', '回転'],
];

// その座標系が中心に据えている天体。回転系は「その天体の公転を止めて見せる」ものなので、
// 原点(衛星なら親惑星)ではなく rotatingWith が選ばれた天体にあたる。
function bodyOfFrame(frame: ReferenceFrame): AttractorId {
  return frame.rotatingWith ?? frame.center;
}

export class FramePicker {
  readonly element: HTMLElement;
  onSelect: ((frame: ReferenceFrame) => void) | null = null;

  private readonly body: BodyPicker<AttractorId>;
  private readonly rotation: SegmentedControl<RotationMode>;
  private frames: readonly ReferenceFrame[] = [];
  private bodyValue: AttractorId;
  private rotationValue: RotationMode = 'inertial';

  // title は見出し、hudRoot は天体選択ポップアップの親。
  constructor(hudRoot: HTMLElement, title: string, private readonly ephemeris: Ephemeris) {
    this.bodyValue = ephemeris.originId;
    this.element = document.createElement('div');
    this.body = new BodyPicker<AttractorId>(hudRoot, title, (id) => {
      this.bodyValue = id;
      this.emit();
    });
    this.rotation = new SegmentedControl<RotationMode>('基準', ROTATION_ITEMS, (mode) => {
      this.rotationValue = mode;
      this.emit();
    });
    this.element.appendChild(this.body.element);
    this.element.appendChild(this.rotation.element);
  }

  // 選べる座標系の一覧を差し替える。天体選択の候補はここから導出するので、呼び出し側は
  // 座標系の配列だけを渡せばよい。
  setFrames(frames: readonly ReferenceFrame[], dynamicAttractors: readonly Attractor[]): void {
    this.frames = frames;
    const registry = this.ephemeris.registry;
    const ids = [...new Set(frames.map(bodyOfFrame))];
    const items = ids.map((id) => [id, celestialBodyName(id)] as const);
    const inRegistry = (id: AttractorId): boolean => id in registry;
    const byClass = (cls: BodyClass) => items.filter(([id]) => inRegistry(id) && bodyClassOf(registry, id) === cls);
    // 先頭は「いま選んでいる系」— 座標系を切り替える動機はほぼ常に同じ系の中の移動なので、
    // 1クリック目に置く。
    const selectedParent = inRegistry(this.bodyValue) ? primaryOf(registry, this.bodyValue) : null;
    const near = items.filter(([id]) => id === this.bodyValue || id === selectedParent
      || (inRegistry(id) && (primaryOf(registry, id) === selectedParent || primaryOf(registry, id) === this.bodyValue)));
    const dynamicIds = new Set(dynamicAttractors.filter((a) => !inRegistry(a.id)).map((a) => a.id));
    const groups: BodyPickerGroup<AttractorId>[] = [
      { label: 'いま選んでいる系', items: near },
      { label: '恒星', items: byClass('star') },
      { label: '惑星', items: byClass('planet') },
      { label: '衛星', items: byClass('satellite') },
      { label: '準惑星', items: byClass('dwarf') },
      { label: '小天体', items: byClass('smallBody') },
      { label: 'その他', items: items.filter(([id]) => dynamicIds.has(id)) },
    ];
    this.body.setGroups(groups.filter((g) => g.items.length > 0));
    this.syncRotationAvailability();
  }

  // 現在の座標系を表示へ反映する。
  setSelected(frame: ReferenceFrame): void {
    this.bodyValue = bodyOfFrame(frame);
    this.rotationValue = frame.rotatingWith === null ? 'inertial' : 'rotating';
    this.body.setSelected(this.bodyValue);
    this.rotation.setSelected(this.rotationValue);
    this.syncRotationAvailability();
  }

  // 選ばれた天体が回転系を持たない(恒星など)なら、慣性だけを選べるようにする —
  // 選ばせてから拒否しないため。
  private syncRotationAvailability(): void {
    const hasRotating = this.frames.some((f) => f.rotatingWith === this.bodyValue);
    this.rotation.setItems(hasRotating ? ROTATION_ITEMS : ROTATION_ITEMS.slice(0, 1));
    this.rotation.setSelected(this.rotationValue);
  }

  // いまの天体と回転の組に対応する座標系を通知する。組に対応するものが無ければ慣性へ倒す。
  private emit(): void {
    const wanted = this.rotationValue === 'rotating'
      ? this.frames.find((f) => f.rotatingWith === this.bodyValue)
      : this.frames.find((f) => f.center === this.bodyValue && f.rotatingWith === null);
    const frame = wanted ?? this.frames.find((f) => f.center === this.bodyValue && f.rotatingWith === null);
    if (frame === undefined) return;
    this.setSelected(frame);
    this.onSelect?.(frame);
  }
}

