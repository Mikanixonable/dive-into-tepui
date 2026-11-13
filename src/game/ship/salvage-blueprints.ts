// 鹵獲の設計図: ラン内の撃破数の節目で棚へ追加する先端部の定義と、節目の跨ぎ・
// 残り撃破数の導出。先端部は設計図として保存するのと同じく ShipAssembly から直列化して組む
// (SPEC GAME.md 3.1)。
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import { ShipAssembly } from './ship-assembly';
import { createShipModuleInstance } from './ship-module-instance';
import { serializeShipAssembly, type SerializedShipAssembly } from './ship-save';
import type { ShipBlueprintShelf } from './ship-blueprint';

// 鹵獲の設計図1件。kills は授与されるラン内の撃破数、id・name は棚での重複判定に使う固定値。
// 設計図として棚へ入れるときは授与の記録側が作成時刻を刻んで ShipBlueprint へ組む。
export interface SalvageBlueprint {
  readonly kills: number;
  readonly id: string;
  readonly name: string;
  readonly piece: SerializedShipAssembly;
}

function instance(definitionId: string, id: string) {
  return createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id);
}

// 砲座: 装甲ブロックの前端へ機関砲を付けた先端部。
function gunPodPiece(): SerializedShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  assembly.addRoot(instance('armor-combat', 'armor'));
  assembly.prepend(instance('weapon-gatling', 'weapon'));
  assembly.assertValid();
  return serializeShipAssembly(assembly);
}

// 物資ポッド: 戦闘用主燃料タンクの後端へ RCS タンクを連ねた先端部。
function supplyPodPiece(): SerializedShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  assembly.addRoot(instance('tank-combat-main', 'main-tank'));
  assembly.append(instance('tank-6-rcs', 'rcs-tank'));
  assembly.assertValid();
  return serializeShipAssembly(assembly);
}

// 強襲艇: コックピット・主燃料タンク・RCS スラスター2基・主推進器を直列に連ねた、
// 切り離せばそのまま飛べる最小構成。
function assaultCraftPiece(): SerializedShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  assembly.addRoot(instance('cockpit-standard', 'cockpit'));
  assembly.append(instance('tank-6-main', 'main-tank'));
  assembly.append(instance('rcs-standard', 'rcs-1'));
  assembly.append(instance('rcs-standard', 'rcs-2'));
  assembly.append(instance('thruster-standard', 'thruster'));
  assembly.assertValid();
  return serializeShipAssembly(assembly);
}

// 撃破数の節目と授与する設計図の対応。節目の小さい順に並べる。
export const SALVAGE_BLUEPRINTS: readonly SalvageBlueprint[] = [
  { kills: 3, id: 'salvage-gunpod', name: '鹵獲: 砲座', piece: gunPodPiece() },
  { kills: 10, id: 'salvage-supply-pod', name: '鹵獲: 物資ポッド', piece: supplyPodPiece() },
  { kills: 25, id: 'salvage-assault-craft', name: '鹵獲: 強襲艇', piece: assaultCraftPiece() },
];

// 節目の設計図が既に授与済みか。このランで授与を記録した名前と、棚に既にある名前の両方で見る —
// 棚への書き戻しは授与の記録より遅れ得るので、片方だけでは重複や抜けが出る。
function salvageGranted(name: string, grantedNames: ReadonlySet<string>, shelf: ShipBlueprintShelf): boolean {
  return grantedNames.has(name) || shelf.blueprints.some(blueprint => blueprint.name === name);
}

// 撃破数が previous から kills へ増えたときに跨いだ節目の設計図のうち、まだ授与されていないもの。
// 1撃破で複数の節目を跨いだときは全部返す。
export function crossedSalvageBlueprints(
  previous: number, kills: number, grantedNames: ReadonlySet<string>, shelf: ShipBlueprintShelf,
): readonly SalvageBlueprint[] {
  return SALVAGE_BLUEPRINTS.filter(entry =>
    previous < entry.kills && entry.kills <= kills && !salvageGranted(entry.name, grantedNames, shelf));
}

// 次の鹵獲までの残り撃破数。残る節目がすべて授与済みなら null。
export function nextSalvageRemaining(
  kills: number, grantedNames: ReadonlySet<string>, shelf: ShipBlueprintShelf,
): number | null {
  for (const entry of SALVAGE_BLUEPRINTS) {
    if (entry.kills <= kills) continue;
    if (salvageGranted(entry.name, grantedNames, shelf)) continue;
    return entry.kills - kills;
  }
  return null;
}
