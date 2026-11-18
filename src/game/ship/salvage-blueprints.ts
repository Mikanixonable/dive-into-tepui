// 鹵獲の設計図: ラン内の撃破数の節目で棚へ追加する先端部の定義と、節目の跨ぎ・
// 残り撃破数の導出。先端部は設計図として保存するのと同じく ShipAssembly から直列化して組む
// (SPEC GAME.md 3.1)。補給艇の積荷も、同じ組み立てを船体の外側へ連ねて作る。
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import { ShipAssembly } from './ship-assembly';
import { createShipModuleInstance, type ShipModuleState } from './ship-module-instance';
import { serializeShipAssembly, type SerializedShipAssembly } from './ship-assembly-serialization';
import type { ShipBlueprintShelf } from './ship-blueprint';

// 鹵獲の設計図1件。kills は授与されるラン内の撃破数、id・name は棚での重複判定に使う固定値。
// 設計図として棚へ入れるときは授与の記録側が作成時刻を刻んで ShipBlueprint へ組む。
interface SalvageBlueprint {
  readonly kills: number;
  readonly id: string;
  readonly name: string;
  readonly kind: SalvageKind;
  readonly piece: SerializedShipAssembly;
}

// 鹵獲品の種類。
export type SalvageKind = 'gunpod' | 'supply-pod' | 'assault-craft';

// 鹵獲品の連なる側(船首 'bow' か船尾 'stern')。
export function salvageCargoSide(kind: SalvageKind): 'bow' | 'stern' {
  return CARGO_CHAINS[kind].side;
}

// value が鹵獲品の種類の名前か。
export function isSalvageKind(value: unknown): value is SalvageKind {
  return typeof value === 'string' && Object.hasOwn(CARGO_CHAINS, value);
}

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

// 鹵獲品の部品の状態。intact は設計図どおりの新品、salvaged は鹵獲品として積まれた状態で、
// コックピットは損傷している(SPEC GAME.md 2.3)。
type SalvageCondition = 'intact' | 'salvaged';

// 鹵獲品 kind の部品を assembly へ連ねる。anchorId が null なら先頭の部品を根に置き、そうでなければ
// anchorId の外側へ連ねる。idPrefix は部品の識別子の前に付け、同じ船体へ複数の鹵獲品を入れても
// 識別子が衝突しないようにする。連ねた最後の部品の識別子を返す。
export function appendSalvageCargo(
  assembly: ShipAssembly, kind: SalvageKind, anchorId: string | null, idPrefix: string, condition: SalvageCondition,
): string {
  const { side, links } = CARGO_CHAINS[kind];
  const ids = links.map(link => `${idPrefix}${link.id}`);
  // 先頭の部品は根(anchorId があればその外側)へ置き、残りは直前の部品の側へ連ねる。
  links.forEach((link, i) => {
    const definition = SHIP_MODULE_CATALOG.require(link.definitionId);
    const state: ShipModuleState = condition === 'salvaged' && definition.kind === 'cockpit' ? { hp: 0 } : {};
    const module = createShipModuleInstance(definition, ids[i]!, state);
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
  appendSalvageCargo(assembly, kind, null, '', 'intact');
  assembly.assertValid();
  return serializeShipAssembly(assembly);
}

// 撃破数の節目と授与する設計図の対応。節目の小さい順に並べる。
export const SALVAGE_BLUEPRINTS: readonly SalvageBlueprint[] = [
  { kills: 3, id: 'salvage-gunpod', name: '鹵獲: 砲座', kind: 'gunpod', piece: salvagePiece('gunpod') },
  { kills: 10, id: 'salvage-supply-pod', name: '鹵獲: 物資ポッド', kind: 'supply-pod', piece: salvagePiece('supply-pod') },
  { kills: 25, id: 'salvage-assault-craft', name: '鹵獲: 強襲艇', kind: 'assault-craft', piece: salvagePiece('assault-craft') },
];

// 物資ポッドの節目の雛形と、最後の節目の撃破数。
const SUPPLY_POD_ENTRY = SALVAGE_BLUEPRINTS.find(entry => entry.kind === 'supply-pod')!;
const LAST_SALVAGE_KILLS = SALVAGE_BLUEPRINTS[SALVAGE_BLUEPRINTS.length - 1]!.kills;

// ステージ00で、最後の節目より後に物資ポッドを授与する撃破数の間隔 [機](SPEC GAME.md 3.1)。
export const SALVAGE_REPEAT_EVERY = 15;

// 撃破数 kills までに到達する節目を小さい順に返す。repeatEvery を与えると、最後の節目より後は
// 物資ポッドの節目が repeatEvery ごとに続く。
function milestonesUpTo(kills: number, repeatEvery: number | null): SalvageBlueprint[] {
  const milestones = SALVAGE_BLUEPRINTS.filter(entry => entry.kills <= kills);
  if (repeatEvery === null) return milestones;
  for (let k = LAST_SALVAGE_KILLS + repeatEvery; k <= kills; k += repeatEvery) {
    milestones.push({ ...SUPPLY_POD_ENTRY, kills: k });
  }
  return milestones;
}

// 撃破数が previous から kills へ増えたときに跨いだ鹵獲の節目。1撃破で複数を跨いだら全部返す。
// 授与はラン内で毎回起きるので、棚の内容は見ない。
export function crossedSalvageMilestones(
  previous: number, kills: number, repeatEvery: number | null,
): readonly SalvageBlueprint[] {
  return milestonesUpTo(kills, repeatEvery).filter(entry => entry.kills > previous);
}

// 次の鹵獲の節目までの残り撃破数。repeatEvery を与えたときは、最後の節目より後も必ず次がある。
export function nextSalvageMilestoneRemaining(kills: number, repeatEvery: number | null): number | null {
  const fixed = SALVAGE_BLUEPRINTS.find(entry => entry.kills > kills);
  if (fixed !== undefined) return fixed.kills - kills;
  if (repeatEvery === null) return null;
  const steps = Math.floor((kills - LAST_SALVAGE_KILLS) / repeatEvery) + 1;
  return LAST_SALVAGE_KILLS + steps * repeatEvery - kills;
}

// 節目の設計図が既に授与済みか。このランで授与を記録した名前と、棚に既にある名前の両方で見る —
// 棚への書き戻しは授与の記録より遅れ得るので、片方だけでは重複や抜けが出る。
export function salvageGranted(name: string, grantedNames: ReadonlySet<string>, shelf: ShipBlueprintShelf): boolean {
  return grantedNames.has(name) || shelf.blueprints.some(blueprint => blueprint.name === name);
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
