// 鹵獲の設計図: ラン内の撃破数の節目で棚へ追加する先端部の定義と、節目の跨ぎ・
// 残り撃破数の導出。先端部は設計図として保存するのと同じく ShipAssembly から直列化して組む
// (SPEC GAME.md 3.1)。補給艇の積荷も、同じ組み立てを船体の外側へ連ねて作る。
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

// 鹵獲品の種類。
export type SalvageKind = 'gunpod' | 'supply-pod' | 'assault-craft';

// 先端部を根から外へ組む1部品。id は先端部の中での名前で、連ねるときは接頭辞を付けて使う。
interface CargoLink {
  readonly id: string;
  readonly definitionId: string;
}

// 鹵獲品の組み立て。links の先頭が根で、残りは side の向きへ1つずつ連なる。
// 砲座は砲口を船首へ向けたまま連ねるので船首側へ、ほかは船尾側へ連ねる。
interface CargoChain {
  readonly side: 'bow' | 'stern';
  readonly links: readonly CargoLink[];
}

const CARGO_CHAINS: Readonly<Record<SalvageKind, CargoChain>> = {
  // 砲座: 装甲ブロックの前端へ機関砲を付けた先端部。
  gunpod: {
    side: 'bow',
    links: [
      { id: 'armor', definitionId: 'armor-combat' },
      { id: 'weapon', definitionId: 'weapon-gatling' },
    ],
  },
  // 物資ポッド: 戦闘用主燃料タンクの後端へ RCS タンクを連ねた先端部。
  'supply-pod': {
    side: 'stern',
    links: [
      { id: 'main-tank', definitionId: 'tank-combat-main' },
      { id: 'rcs-tank', definitionId: 'tank-6-rcs' },
    ],
  },
  // 強襲艇: コックピット・主燃料タンク・RCS スラスター2基・主推進器を直列に連ねた、
  // 切り離せばそのまま飛べる最小構成。
  'assault-craft': {
    side: 'stern',
    links: [
      { id: 'cockpit', definitionId: 'cockpit-standard' },
      { id: 'main-tank', definitionId: 'tank-6-main' },
      { id: 'rcs-1', definitionId: 'rcs-standard' },
      { id: 'rcs-2', definitionId: 'rcs-standard' },
      { id: 'thruster', definitionId: 'thruster-standard' },
    ],
  },
};

function instance(definitionId: string, id: string) {
  return createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id);
}

// 鹵獲品 kind の部品を assembly へ連ねる。anchorId が null なら先頭の部品を根に置き、そうでなければ
// anchorId の外側へ連ねる。idPrefix は部品の識別子の前に付け、同じ船体へ複数の鹵獲品を入れても
// 識別子が衝突しないようにする。連ねた最後の部品の識別子を返す。
export function appendSalvageCargo(
  assembly: ShipAssembly, kind: SalvageKind, anchorId: string | null, idPrefix: string,
): string {
  const { side, links } = CARGO_CHAINS[kind];
  const ids = links.map(link => `${idPrefix}${link.id}`);
  links.forEach((link, i) => {
    const module = instance(link.definitionId, ids[i]!);
    const parentId = i === 0 ? anchorId : ids[i - 1]!;
    if (parentId === null) assembly.addRoot(module);
    else if (side === 'bow') assembly.prepend(module, parentId);
    else assembly.append(module, parentId);
  });
  return ids[ids.length - 1]!;
}

// 鹵獲品1種の先端部を根から連ねて、設計図として直列化する。
function salvagePiece(kind: SalvageKind): SerializedShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  appendSalvageCargo(assembly, kind, null, '');
  assembly.assertValid();
  return serializeShipAssembly(assembly);
}

// 撃破数の節目と授与する設計図の対応。節目の小さい順に並べる。
export const SALVAGE_BLUEPRINTS: readonly SalvageBlueprint[] = [
  { kills: 3, id: 'salvage-gunpod', name: '鹵獲: 砲座', piece: salvagePiece('gunpod') },
  { kills: 10, id: 'salvage-supply-pod', name: '鹵獲: 物資ポッド', piece: salvagePiece('supply-pod') },
  { kills: 25, id: 'salvage-assault-craft', name: '鹵獲: 強襲艇', piece: salvagePiece('assault-craft') },
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
