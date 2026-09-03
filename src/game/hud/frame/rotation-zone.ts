// マップの座標系UIのうち「何の回転に合わせて回すか」を選ばせるゾーン。いまカメラがいる系の
// 天体ぶんの公転・自転と、役割(操作対象の船/ターゲット)の公転を選択肢として並べ、
// 選ばれた回転対象を返す。
import { FrameRole, FrameRotationSource, frameRoleAnchorId, rotationSourceKey } from '../../../physics/frame';
import { SegmentedControl } from '../widgets';
import { objectName } from '../object-name';
import type { CelestialEntity } from '../../celestial/celestial-entity/celestial-entity';
import type { CelestialSystem } from '../../celestial/celestial-system';
import {
  rotationFollowKey, rotationFollowName, type CameraRotationFollow,
} from '../../camera/rotation-follow';

export class RotationZone {
  public readonly element: HTMLElement;
  // null は慣性系(回転させない)。
  public onSelect: ((rotatingWith: FrameRotationSource | null) => void) | null = null;

  // 正規化キー → 回転対象。SegmentedControl は値を参照同一性で比べるので、組み直すたびに
  // 新しくなるオブジェクトではなく安定した文字列を値に持たせる。
  private readonly sources = new Map<string, FrameRotationSource | null>([['', null]]);
  private readonly control: SegmentedControl<string>;

  // 選択肢の id(天体・役割トークン)の表示名。
  private readonly nameOf = (id: string): string => objectName(id, (i) => this.celestialSystem.nameOf(i));

  // title は選択肢見出し。
  public constructor(title: string, private readonly celestialSystem: CelestialSystem) {
    this.control = new SegmentedControl<string>(
      title, [['', '慣性系']], (key) => this.onSelect?.(this.sources.get(key) ?? null),
    );
    this.element = this.control.element;
  }

  // 選択肢を「慣性系・各天体の公転・各天体の自転・validRoles の役割の公転」へ組み直す。
  // validRoles には、周回軌道にあって公転を固定できる役割だけを渡す。
  public setNearby(
    members: readonly string[], displayTime: number, validRoles: readonly FrameRole[] = [],
  ): void {
    this.sources.clear();
    this.sources.set('', null);
    const items: (readonly [string, string])[] = [['', '慣性系']];

    // 主天体を持つ天体だけが公転回転系を持つ(恒星と、恒星の無い星系の惑星はここで外れる)。
    const revolvable: CelestialEntity[] = [];
    for (const id of members) {
      const entity = this.celestialSystem.find(id);
      if (entity === null || entity.motion.primary === null) continue;
      revolvable.push(entity);
    }
    // 選択肢を1つ、照合キーと正式名を添えて積む。
    const add = (source: FrameRotationSource): void => {
      const key = rotationSourceKey(source);
      this.sources.set(key, source);
      items.push([key, rotationFollowName(source, this.celestialSystem, this.nameOf)]);
    };
    for (const entity of revolvable) add({ kind: 'revolution', id: entity.id });
    for (const entity of revolvable) {
      if (entity.motion.spinRotationAt(displayTime) !== null) add({ kind: 'spin', id: entity.id });
    }
    for (const role of validRoles) add({ kind: 'revolution', id: frameRoleAnchorId(role) });
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
  // null は慣性系(回転させない)。
  public onSelect: ((follow: CameraRotationFollow | null) => void) | null = null;

  // 照合キー → 選択肢。SegmentedControl は値を参照同一性で比べるので、組み直すたびに
  // 新しくなるオブジェクトではなく安定した文字列を値に持たせる。
  private readonly follows = new Map<string, CameraRotationFollow | null>([['', null]]);
  private readonly control: SegmentedControl<string>;

  // 選択肢の id(天体・役割トークン)の表示名。
  private readonly nameOf = (id: string): string => objectName(id, (i) => this.celestialSystem.nameOf(i));

  // title は選択肢見出し。
  public constructor(title: string, private readonly celestialSystem: CelestialSystem) {
    this.control = new SegmentedControl<string>(
      title, [['', '慣性系']], (key) => this.onSelect?.(this.follows.get(key) ?? null),
    );
    this.element = this.control.element;
  }

  // 選択肢を「慣性系 + follows」へ組み直す。
  public setChoices(follows: readonly CameraRotationFollow[]): void {
    this.follows.clear();
    this.follows.set('', null);
    const items: (readonly [string, string])[] = [['', '慣性系']];
    for (const follow of follows) {
      const key = rotationFollowKey(follow);
      this.follows.set(key, follow);
      items.push([key, rotationFollowName(follow, this.celestialSystem, this.nameOf)]);
    }
    this.control.setItems(items);
  }

  // 選択中の表示を合わせる。
  public setSelected(follow: CameraRotationFollow | null): void {
    this.control.setSelected(rotationFollowKey(follow));
  }
}
