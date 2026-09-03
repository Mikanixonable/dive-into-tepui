// マップの座標系UIのうち「何の回転に合わせて回すか」を選ばせるゾーン。いまカメラがいる系の
// 天体ぶんの公転・自転と、役割(操作対象の船/ターゲット)の公転を選択肢として並べ、
// 選ばれた回転対象を返す。
import { FrameRole, FrameRotationSource, rotationSourceKey } from '../../../physics/frame';
import { SegmentedControl } from '../../../hud/widgets';
import { frameRoleName } from './frame-labels';
import type { CelestialMotion } from '../../../physics/celestial-motion';
import type { CelestialEntity } from '../../celestial/celestial-entity/celestial-entity';
import type { CelestialSystem } from '../../celestial/celestial-system';
import { rotationFollowKey, type CameraRotationFollow } from '../../camera/focus-camera';

export class RotationZone {
  public readonly element: HTMLElement;
  // null は「解除」= 回転させない(慣性系)。
  public onSelect: ((rotatingWith: FrameRotationSource | null) => void) | null = null;

  // 正規化キー → 回転対象。SegmentedControl は値を参照同一性で比べるので、組み直すたびに
  // 新しくなるオブジェクトではなく安定した文字列を値に持たせる。
  private readonly sources = new Map<string, FrameRotationSource | null>([['', null]]);
  private readonly control: SegmentedControl<string>;

  // title は選択肢見出し。
  public constructor(title: string, private readonly celestialSystem: CelestialSystem) {
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
    this.sources.clear();
    this.sources.set('', null);
    const items: (readonly [string, string])[] = [['', '解除']];

    // 主天体を持つ天体だけが公転回転系を持つ(恒星と、恒星の無い星系の惑星はここで外れる)。
    const revolvable: (readonly [CelestialEntity, CelestialMotion])[] = [];
    for (const id of members) {
      const entity = this.celestialSystem.find(id);
      const primary = entity?.motion.primary ?? null;
      if (entity === null || primary === null) continue;
      revolvable.push([entity, primary]);
    }
    for (const [entity, primary] of revolvable) {
      const source: FrameRotationSource = { kind: 'revolution', id: entity.id };
      const key = rotationSourceKey(source);
      this.sources.set(key, source);
      items.push([key, `${this.celestialSystem.nameOf(primary.id)}-${entity.name}回転座標系`]);
    }
    for (const [entity] of revolvable) {
      if (entity.motion.spinRotationAt(displayTime) === null) continue;
      const source: FrameRotationSource = { kind: 'spin', id: entity.id };
      const key = rotationSourceKey(source);
      this.sources.set(key, source);
      items.push([key, `${entity.name}自転座標系`]);
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

// カメラ区画の回転ゾーン。フォーカス対象から導かれた選択肢(公転・自転・姿勢)を並べ、
// 選ばれた回転追従を返す。選択肢の導出はカメラ(availableRotationFollows)が持ち、
// このゾーンは並べて選ばせるだけ。
export class CameraRotationZone {
  public readonly element: HTMLElement;
  // null は「解除」= 回転させない(慣性系)。
  public onSelect: ((follow: CameraRotationFollow | null) => void) | null = null;

  // 照合キー → 選択肢。SegmentedControl は値を参照同一性で比べるので、組み直すたびに
  // 新しくなるオブジェクトではなく安定した文字列を値に持たせる。
  private readonly follows = new Map<string, CameraRotationFollow | null>([['', null]]);
  private readonly control: SegmentedControl<string>;

  // title は選択肢見出し。
  public constructor(title: string, private readonly celestialSystem: CelestialSystem) {
    this.control = new SegmentedControl<string>(
      title, [['', '解除']], (key) => this.onSelect?.(this.follows.get(key) ?? null),
    );
    this.element = this.control.element;
  }

  // 選択肢を「解除 + follows」へ組み直す。
  public setChoices(follows: readonly CameraRotationFollow[]): void {
    this.follows.clear();
    this.follows.set('', null);
    const items: (readonly [string, string])[] = [['', '解除']];
    for (const follow of follows) {
      const key = rotationFollowKey(follow);
      this.follows.set(key, follow);
      items.push([key, this.followLabel(follow)]);
    }
    this.control.setItems(items);
  }

  // 天体は座標系の名前で、機体(天体レジストリに無い id)は種別の名前で書く。
  private followLabel(follow: CameraRotationFollow): string {
    if (follow.kind === 'attitude') return '姿勢追従';
    const entity = this.celestialSystem.find(follow.id);
    if (entity === null) return follow.kind === 'revolution' ? '公転' : '自転';
    if (follow.kind === 'spin') return `${entity.name}自転座標系`;
    const primary = entity.motion.primary;
    return primary !== null
      ? `${this.celestialSystem.nameOf(primary.id)}-${entity.name}回転座標系`
      : `${entity.name}回転座標系`;
  }

  // 選択中の表示を合わせる。
  public setSelected(follow: CameraRotationFollow | null): void {
    this.control.setSelected(rotationFollowKey(follow));
  }
}
