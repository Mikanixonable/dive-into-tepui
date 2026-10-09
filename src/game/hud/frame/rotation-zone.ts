// マップの座標系UIのうち「何の回転に合わせて回すか」を選ばせるゾーン。いまカメラがいる系の
// 天体ぶんの公転・自転と、役割(操作対象の船/ターゲット)の公転を選択肢として並べ、
// 選ばれた回転対象を返す。
import {
  FRAME_ROLES, type FrameAnchorSource, type FrameRotationSource, frameRoleAnchorId, rotationSourceKey,
} from '../../../physics/frame';
import { SegmentedControl } from '../../../hud/widgets';
import { rotationFollowChoiceLabel, rotationSourceChoiceLabel } from './frame-labels';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import { rotationFollowKey, type CameraRotationFollow } from '../../viewer/focus-camera-selection';
import type { CelestialBody } from '../../../physics/celestial-body';

// 値を安定した文字列キーへ写して扱う SegmentedControl。SegmentedControl は値を参照同一性で
// 比べるので、組み直すたびに新しくなるオブジェクトをそのまま値にすると選択照合が外れる。
// 選択肢の先頭の項は常に「解除」(キー ''、値 null)。
class KeyedSegmentedControl<V> {
  public readonly element: HTMLElement;
  private readonly values = new Map<string, V | null>([['', null]]);
  private readonly control: SegmentedControl<string>;

  // keyOf は値から安定キー(null では '')を引く。onSelect にはキーから復元した値を渡す。
  public constructor(
    title: string,
    private readonly keyOf: (value: V | null) => string,
    onSelect: (value: V | null) => void,
  ) {
    this.control = new SegmentedControl<string>(
      title, [['', '解除']], (key) => onSelect(this.values.get(key) ?? null),
    );
    this.element = this.control.element;
  }

  // 選択肢を「解除 + choices」へ組み直す。choices は [値, ラベル] の並びでその順に並ぶ。
  public setChoices(choices: readonly (readonly [V, string])[]): void {
    this.values.clear();
    this.values.set('', null);
    const items: (readonly [string, string])[] = [['', '解除']];
    for (const [value, label] of choices) {
      const key = this.keyOf(value);
      this.values.set(key, value);
      items.push([key, label]);
    }
    this.control.setItems(items);
  }

  // 選択中の表示を合わせる。
  public setSelected(value: V | null): void {
    this.control.setSelected(this.keyOf(value));
  }
}

export class RotationZone {
  public readonly element: HTMLElement;
  // null は「解除」= 回転させない(慣性系)。
  public onSelect: ((rotatingWith: FrameRotationSource | null) => void) | null = null;

  private readonly control: KeyedSegmentedControl<FrameRotationSource>;

  // title は選択肢見出し。frameAnchors は役割トークンが周回軌道にあるかの判定に使う。
  public constructor(
    title: string,
    private readonly celestialBodies: CelestialBodies,
    private readonly frameAnchors: Pick<FrameAnchorSource, 'attractorOf'>,
  ) {
    this.control = new KeyedSegmentedControl<FrameRotationSource>(
      title, rotationSourceKey, (source) => this.onSelect?.(source),
    );
    this.element = this.control.element;
  }

  // 選択肢を「解除・各天体の公転・各天体の自転・周回軌道にある役割の公転」へ組み直す。
  public setNearby(members: readonly string[], displayTime: number): void {
    // 主天体を持つ天体だけが公転回転系を持つ(恒星と、恒星の無い星系の惑星はここで外れる)。
    const revolvable: (readonly [string, CelestialBody, CelestialBody])[] = [];
    for (const id of members) {
      const motion = this.celestialBodies.findMotion(id);
      const primary = motion?.primary ?? null;
      if (motion === null || primary === null) continue;
      revolvable.push([id, motion, primary]);
    }

    const choices: (readonly [FrameRotationSource, string])[] = [];
    for (const [id] of revolvable) {
      const source: FrameRotationSource = { kind: 'revolution', id };
      choices.push([source, rotationSourceChoiceLabel(this.celestialBodies, source)]);
    }
    for (const [id, motion] of revolvable) {
      if (motion.spinRotationAt(displayTime) === null) continue;
      const source: FrameRotationSource = { kind: 'spin', id };
      choices.push([source, rotationSourceChoiceLabel(this.celestialBodies, source)]);
    }
    // 役割はその時点の対象が周回軌道にあるものだけが公転を固定できる。
    for (const role of FRAME_ROLES) {
      const id = frameRoleAnchorId(role);
      if (this.frameAnchors.attractorOf(id, displayTime) === null) continue;
      const source: FrameRotationSource = { kind: 'revolution', id };
      choices.push([source, rotationSourceChoiceLabel(this.celestialBodies, source)]);
    }
    this.control.setChoices(choices);
  }

  // 選択中の表示を合わせる。
  public setSelected(rotatingWith: FrameRotationSource | null): void {
    this.control.setSelected(rotatingWith);
  }
}

// カメラ区画の回転ゾーン。フォーカス対象から導かれた選択肢(公転・自転・姿勢)を並べ、
// 選ばれた回転追従を返す。選択肢の導出はカメラ(availableRotationFollows)が持ち、
// このゾーンは並べて選ばせるだけ。
export class CameraRotationZone {
  public readonly element: HTMLElement;
  // null は「解除」= 回転させない(慣性系)。
  public onSelect: ((follow: CameraRotationFollow | null) => void) | null = null;

  private readonly control: KeyedSegmentedControl<CameraRotationFollow>;

  // title は選択肢見出し。
  public constructor(title: string, private readonly celestialBodies: CelestialBodies) {
    this.control = new KeyedSegmentedControl<CameraRotationFollow>(
      title, rotationFollowKey, (follow) => this.onSelect?.(follow),
    );
    this.element = this.control.element;
  }

  // 選択肢を「解除 + follows」へ組み直す。
  public setChoices(follows: readonly CameraRotationFollow[]): void {
    this.control.setChoices(
      follows.map((follow) => [follow, rotationFollowChoiceLabel(this.celestialBodies, follow)] as const),
    );
  }

  // 選択中の表示を合わせる。
  public setSelected(follow: CameraRotationFollow | null): void {
    this.control.setSelected(follow);
  }
}
