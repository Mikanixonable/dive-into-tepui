// マップの座標系UIのうち「何の回転に合わせて回すか」を選ばせるゾーン。いまカメラがいる系の
// 天体ぶんの公転・自転と、役割(操作対象の船/ターゲット)の公転を SegmentedControl の選択肢として
// 並べる。座標系そのもの(原点込み)は呼び出し側が別途選ぶ原点と組み合わせて Ephemeris.frameOf で
// 作るので、ここは回転対象の id だけを返す。
import { CelestialBodyId } from '../../physics/celestial-body';
import { Ephemeris } from '../../physics/ephemeris';
import { FrameRole, FrameRotationSource, rotationSourceKey } from '../../physics/frame';
import { primaryOf } from '../../physics/solar-system';
import { SegmentedControl } from './widgets';
import { celestialBodyName, frameRoleName } from './frame-labels';

export class RotationZone {
  readonly element: HTMLElement;
  // null は「解除」= 回転させない(慣性系)。
  onSelect: ((rotatingWith: FrameRotationSource | null) => void) | null = null;

  // SegmentedControl は値を参照同一性(Map のキー)で比較するので、setNearby のたびに新しく
  // 作る FrameRotationSource オブジェクトをそのまま値には使えない。文字列キーを値にし、
  // 対応する FrameRotationSource をここへ引けるようにする。
  private readonly sources = new Map<string, FrameRotationSource | null>([['', null]]);
  private readonly control: SegmentedControl<string>;
  private readonly ephemeris: Ephemeris;

  // title は選択肢見出し。
  constructor(title: string, ephemeris: Ephemeris) {
    this.ephemeris = ephemeris;
    this.control = new SegmentedControl<string>(
      title, [['', '解除']], (key) => this.onSelect?.(this.sources.get(key) ?? null),
    );
    this.element = this.control.element;
  }

  // 渡された天体列・表示時刻・有効な役割に応じて選択肢を組み直す。
  // 公転: 登録天体かつ恒星でないもの(Ephemeris が回転系を作れる条件と同じ)。
  // 自転: 上記のうち自転モデルを持つもの(spinRotationAt(id, displayTime) が null でないもの)。
  // 役割の公転: validRoles に含まれる役割(離心率1未満の周回軌道にあるかどうかは呼び出し側が判定する
  // — ここは Ephemeris しか知らないため)。
  setNearby(
    members: readonly CelestialBodyId[], displayTime: number, validRoles: readonly FrameRole[] = [],
  ): void {
    const registry = this.ephemeris.registry;
    this.sources.clear();
    this.sources.set('', null);
    const items: (readonly [string, string])[] = [['', '解除']];

    const revolvable: CelestialBodyId[] = [];
    for (const id of members) {
      if (registry[id] === undefined) continue;
      // 恒星は primaryOf が null を返すのでここで外れる。
      if (primaryOf(registry, id) === null) continue;
      revolvable.push(id);
    }
    for (const id of revolvable) {
      const primary = primaryOf(registry, id)!;
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
  setSelected(rotatingWith: FrameRotationSource | null): void {
    this.control.setSelected(rotationSourceKey(rotatingWith));
  }
}
