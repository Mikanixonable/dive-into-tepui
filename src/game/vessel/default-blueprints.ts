// 実装が最初から持つ設計。組立モード(B7・B8)で設計を編集できるようになるまで、生産の対象に
// できる設計はこれだけである。保管庫の設計と同じ形なので、生産の経路はどちらも区別しない。
import * as C from '../const';
import { createBlueprint, type VesselBlueprint } from './blueprint';
import { crewedAssembly } from './vessel-assemblies';

export const CREWED_BLUEPRINT_ID = 'builtin-crewed-ship';

// 既定の有人艦の設計。形状ツリーと搭載要素の配置は既定の設計そのものを読む。
export function crewedShipBlueprint(now: number): VesselBlueprint {
  const assembly = crewedAssembly(C.PLAYER_MAX_HP);
  return createBlueprint({
    id: CREWED_BLUEPRINT_ID,
    name: '有人艦(既定)',
    tree: assembly.tree,
    placements: assembly.placements,
    now,
  });
}
