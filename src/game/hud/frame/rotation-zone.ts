// 座標系パネルのうち「何の回転に合わせて回すか」を選ばせるゾーン。渡された選択肢を慣性系に
// 続けて並べ、選ばれたものを返す。何を並べられるかの導出は camera/rotation-follow.ts が持ち、
// このゾーンは並べて選ばせるだけ。
import { SegmentedControl } from '../widgets';
import { objectName } from '../object-name';
import type { CelestialSystem } from '../../celestial/celestial-system';
import {
  rotationFollowKey, rotationFollowName, type CameraRotationFollow,
} from '../../camera/rotation-follow';

// 姿勢を選べないゾーン(軌道計画区画)は T を FrameRotationSource に絞って使う。
export class RotationZone<T extends CameraRotationFollow = CameraRotationFollow> {
  public readonly element: HTMLElement;
  // null は慣性系(回転させない)。
  public onSelect: ((choice: T | null) => void) | null = null;

  // 照合キー → 選択肢。SegmentedControl は値を参照同一性で比べるので、組み直すたびに
  // 新しくなるオブジェクトではなく安定した文字列を値に持たせる。
  private readonly choices = new Map<string, T | null>([['', null]]);
  private readonly control: SegmentedControl<string>;

  // 選択肢の id(天体・役割トークン)の表示名。
  private readonly nameOf = (id: string): string => objectName(id, (i) => this.celestialSystem.nameOf(i));

  // title は選択肢見出し。
  public constructor(title: string, private readonly celestialSystem: CelestialSystem) {
    this.control = new SegmentedControl<string>(
      title, [['', INERTIAL_ITEM[1]]], (key) => this.onSelect?.(this.choices.get(key) ?? null),
    );
    this.element = this.control.element;
  }

  // 選択肢を「慣性系 + choices」へ組み直す。
  public setChoices(choices: readonly T[]): void {
    this.choices.clear();
    this.choices.set('', null);
    const items: (readonly [string, string])[] = [INERTIAL_ITEM];
    for (const choice of choices) {
      const key = rotationFollowKey(choice);
      this.choices.set(key, choice);
      items.push([key, rotationFollowName(choice, this.celestialSystem, this.nameOf)]);
    }
    this.control.setItems(items);
  }

  // 選択中の表示を合わせる。
  public setSelected(choice: T | null): void {
    this.control.setSelected(rotationFollowKey(choice));
  }
}

// 先頭に必ず置く選択肢。慣性系は他の選択の否定ではなく、向きを ECI に固定するという選択。
const INERTIAL_ITEM = ['', '慣性系'] as const;
