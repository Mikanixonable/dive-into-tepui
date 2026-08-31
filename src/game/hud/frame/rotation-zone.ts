// マップの座標系UIのうち「何の回転に合わせて回すか」を選ばせるゾーン。いまカメラがいる系の
// 天体ぶんの公転・自転と、役割(操作対象の船/ターゲット)の公転を選択肢として並べ、
// 選ばれた回転対象を返す。
import { Ephemeris } from '../../../physics/ephemeris';
import { FrameRole, FrameRotationSource, rotationSourceKey } from '../../../physics/frame';
import { SegmentedControl } from '../widgets';
import { celestialBodyName, frameRoleName } from './frame-labels';

export class RotationZone {
  public readonly element: HTMLElement;
  // null は「解除」= 回転させない(慣性系)。
  public onSelect: ((rotatingWith: FrameRotationSource | null) => void) | null = null;

  // 正規化キー → 回転対象。SegmentedControl は値を参照同一性で比べるので、組み直すたびに
  // 新しくなるオブジェクトではなく安定した文字列を値に持たせる。
  private readonly sources = new Map<string, FrameRotationSource | null>([['', null]]);
  private readonly control: SegmentedControl<string>;
  private readonly ephemeris: Ephemeris;

  // title は選択肢見出し。
  public constructor(title: string, ephemeris: Ephemeris) {
    this.ephemeris = ephemeris;
    this.control = new SegmentedControl<string>(
      title, [['', '解除']], (key) => this.onSelect?.(this.sources.get(key) ?? null),
    );
    this.element = this.control.element;
  }

  // 選択肢を「解除・各天体の公転・各天体の自転・validRoles の役割の公転」へ組み直す。
  // validRoles には、周回軌道にあって公転を固定できる役割だけを渡す。
  public setNearby(
    members: readonly string[], displayTime: number, validRoles: readonly FrameRole[] = [],
  ): void {
    const registry = this.ephemeris.registry;
    this.sources.clear();
    this.sources.set('', null);
    const items: (readonly [string, string])[] = [['', '解除']];

    const revolvable: string[] = [];
    for (const id of members) {
      if (registry[id] === undefined) continue;
      // 恒星は主天体を持たないのでここで外れる。
      if (this.ephemeris.motionOf(id).primary === null) continue;
      revolvable.push(id);
    }
    for (const id of revolvable) {
      const primary = this.ephemeris.motionOf(id).primary!.id;
      const source: FrameRotationSource = { kind: 'revolution', id };
      const key = rotationSourceKey(source);
      this.sources.set(key, source);
      items.push([key, `${celestialBodyName(primary)}-${celestialBodyName(id)}回転座標系`]);
    }
    for (const id of revolvable) {
      if (this.ephemeris.spinRotationAt(id, displayTime) === null) continue;
      const source: FrameRotationSource = { kind: 'spin', id };
      const key = rotationSourceKey(source);
      this.sources.set(key, source);
      items.push([key, `${celestialBodyName(id)}自転座標系`]);
    }
    for (const role of validRoles) {
      const source: FrameRotationSource = { kind: 'revolution', id: `@${role}` };
      const key = rotationSourceKey(source);
      this.sources.set(key, source);
      items.push([key, `${frameRoleName(role)}の公転`]);
    }
    this.control.setItems(items);
  }

  // 選択中の表示を合わせる。
  public setSelected(rotatingWith: FrameRotationSource | null): void {
    this.control.setSelected(rotationSourceKey(rotatingWith));
  }
}
