// 遺物の反射の検出と発見の状態(SPEC GAME.md 3.2)。どの遺物を見つけたか、どの距離の段まで
// 知らせたかを持つ。距離の判定だけをここで行い、告知・台帳への追加は呼び手(ステージ)が行う。
import type { RelicDefinition } from '../../relic/relic-catalog';

// 検出距離のこの倍より離れたら、知らせた段を戻す。次に入ったときは最初から知らせる。
const RESET_FACTOR = 1.2;

// 直列化した形。announced は遺物 id → 知らせた段の数(検出距離の 1/2^段 を越えるたびに増える)。
export interface SerializedRelicHunt {
  readonly discovered: readonly string[];
  readonly announced: Readonly<Record<string, number>>;
}

// 1フレームの観測が返す出来事。
export type RelicSignal =
  | { readonly kind: 'reflection'; readonly relic: RelicDefinition; readonly distance: number }
  | { readonly kind: 'discovered'; readonly relic: RelicDefinition };

export class RelicHunt {
  private readonly discovered: Set<string>;
  private readonly announced: Map<string, number>;

  private constructor(discovered: Iterable<string>, announced: Iterable<readonly [string, number]>) {
    this.discovered = new Set(discovered);
    this.announced = new Map(announced);
  }

  // 何も見つけていない状態から始める。
  public static create(): RelicHunt {
    return new RelicHunt([], []);
  }

  // 直列化した形から復元する。記録が無ければ(null)何も見つけていない状態から始める。
  public static deserialize(serialized: SerializedRelicHunt | null): RelicHunt {
    if (serialized === null) return RelicHunt.create();
    return new RelicHunt(serialized.discovered, Object.entries(serialized.announced));
  }

  // 直列化した形へ畳む。
  public serialize(): SerializedRelicHunt {
    return {
      discovered: [...this.discovered],
      announced: Object.fromEntries(this.announced),
    };
  }

  // 発見済みの遺物の id。
  public get discoveredIds(): readonly string[] {
    return [...this.discovered];
  }

  // id の遺物を発見済みにする。セーブ枠の発見を新しいランへ置くときに使う。
  public markDiscovered(id: string): void {
    this.discovered.add(id);
    this.announced.delete(id);
  }

  // 未発見の遺物について、distanceOf が返す艦からの距離 [m] で検出と発見を判定する。
  // distanceOf が null を返した遺物は判定しない(距離が求まらないとき)。
  public observe(
    relics: readonly RelicDefinition[], distanceOf: (relic: RelicDefinition) => number | null,
  ): RelicSignal[] {
    const signals: RelicSignal[] = [];
    for (const relic of relics) {
      if (this.discovered.has(relic.id)) continue;
      const distance = distanceOf(relic);
      if (distance === null) continue;
      if (distance <= relic.discoverRange) {
        this.markDiscovered(relic.id);
        signals.push({ kind: 'discovered', relic });
        continue;
      }
      if (distance > relic.detectRange * RESET_FACTOR) {
        this.announced.delete(relic.id);
        continue;
      }
      // 検出距離の 1/2^段 を、いま距離が下回っている最初の段まで進める。
      const level = this.announced.get(relic.id) ?? 0;
      let next = level;
      while (distance < relic.detectRange / 2 ** next) next++;
      if (next === level) continue;
      this.announced.set(relic.id, next);
      signals.push({ kind: 'reflection', relic, distance });
    }
    return signals;
  }
}
