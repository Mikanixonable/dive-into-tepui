// 有効な設計図を組む。先端部は単一モジュールだけの木。
import type { ShipBlueprint } from '../../src/game/ship/ship-blueprint';

// 設計図 id の、コックピット1つだけを持つ先端部を載せた設計図。
export function blueprint(id: string): ShipBlueprint {
  return {
    id,
    name: `設計図 ${id}`,
    createdAtReal: 0,
    piece: {
      playerOwned: true,
      modules: [
        { id: 'cockpit', definitionId: 'cockpit-standard', kind: 'cockpit', hp: 100, temperature: 300 },
      ],
      connections: [],
    },
  };
}
