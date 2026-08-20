// 実装が最初から持つ設計。組立モード(B7・B8)で設計を編集できるようになるまで、生産の対象に
// できる設計はこれだけである。保管庫の設計と同じ形なので、生産の経路はどちらも区別しない。
import * as C from '../const';
import { createPart, type AnyPart } from '../game-entity/parts';
import { crewedAssembly, orbitalBaseAssembly } from './vessel-assemblies';

// 単体で生産できる搭載要素の見本。**この一覧は既定の設計が実際に積んでいる要素そのものであり、
// 別に仕様の表を持たない** — 2つ目の表を置くと、そちらの推力や耐久が既定艦と桁でずれても
// 誰も気づかないまま換装できてしまう。同じ種別・同じ名前のものは1つに畳む。
export function producibleParts(): readonly AnyPart[] {
  const seen = new Set<string>();
  const parts: AnyPart[] = [];
  for (const assembly of [crewedAssembly(C.PLAYER_MAX_HP), orbitalBaseAssembly(C.BASE_MAX_HP)]) {
    for (const placement of assembly.placements) {
      const key = `${placement.part.type}:${placement.part.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(placement.part);
    }
  }
  return parts;
}

// 見本と同じ性能値を持つ新品を1つ作る。id は createPart が新しく振り、耐久は満タンから始まる。
export function buildPartFrom(sample: AnyPart): AnyPart {
  const { id: _id, ...spec } = sample;
  return createPart(sample.type, { ...spec, hp: sample.maxHp } as never);
}
