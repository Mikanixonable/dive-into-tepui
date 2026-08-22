// マップの座標系UIのうち「何の公転に合わせて回すか」を選ばせるゾーン。いまカメラがいる系の
// 天体ぶんの回転対象を SegmentedControl の選択肢として並べる。座標系そのもの(原点込み)は
// 呼び出し側が別途選ぶ原点と組み合わせて Ephemeris.frameOf で作るので、ここは回転対象の id だけを返す。
import { CelestialBodyId } from '../../physics/celestial-body';
import { Ephemeris } from '../../physics/ephemeris';
import { FrameRotationSource, rotationSourceKey } from '../../physics/frame';
import { primaryOf } from '../../physics/solar-system';
import { SegmentedControl } from './widgets';
import { celestialBodyName } from './frame-labels';

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

  // 渡された天体列に応じて選択肢を組み直す。回転対象として妥当なのは登録天体かつ
  // 恒星でないもの(Ephemeris が回転系を作れる条件と同じ)。
  setNearby(members: readonly CelestialBodyId[]): void {
    const registry = this.ephemeris.registry;
    this.sources.clear();
    this.sources.set('', null);
    const items: (readonly [string, string])[] = [['', '解除']];
    for (const id of members) {
      if (registry[id] === undefined) continue;
      // 恒星は primaryOf が null を返すのでここで外れる。
      const primary = primaryOf(registry, id);
      if (primary === null) continue;
      const source: FrameRotationSource = { kind: 'revolution', id };
      const key = rotationSourceKey(source);
      this.sources.set(key, source);
      items.push([key, `${celestialBodyName(primary)}-${celestialBodyName(id)}回転座標系`]);
    }
    this.control.setItems(items);
  }

  // 選択中の表示を合わせる。
  setSelected(rotatingWith: FrameRotationSource | null): void {
    this.control.setSelected(rotationSourceKey(rotatingWith));
  }
}
