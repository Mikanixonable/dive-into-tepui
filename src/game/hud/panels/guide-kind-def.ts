// 焼き込みカタログの族 id を、画面に出す群・表示名・並び順へ写す。名前は DEVELOP/SPEC/MAP.md
// 5.2 の表が正本で、日本語訳に英語を添える。族の集合そのものは推測せず、呼び出し側から渡された
// 実在の id だけを解釈する。
//
// 蝶形・トンボ形・共鳴・DRO は族 id ごとに独立した KindDef のまま扱う。それ以外(リヤプノフ・
// 垂直・軸方向・ハロー・短周期・長周期・DPO・LPO)は、点/南北/東西/区間の軸を持つ小題として
// まとめた CombinedKindDef になる。
import { guideKindDefaultColors } from '../../const';
import type { CatalogSystemId } from '../../../physics/orbit-catalog';
import { GUIDE_GROUPS, type GuideGroupId } from '../../celestial/orbit-guide-settings';
import {
  parseGuideKindId, type CombinedKindAxes, type ParsedGuideKindId,
} from '../../celestial/orbit-guide-kind-ids';

// 4.1 の表の日本語訳+英語併記。族の base 名(id の先頭要素)をキーにする。
const BASE_LABELS: Readonly<Record<string, string>> = {
  lyapunov: '平面リヤプノフ軌道(lyapunov)',
  vertical: '垂直軌道(vertical)',
  halo: 'ハロー軌道(halo)',
  axial: '軸方向軌道(axial)',
  butterfly: '蝶形軌道(butterfly)',
  dragonfly: 'トンボ形軌道(dragonfly)',
  short: '短周期軌道(short period)',
  longp: '長周期軌道(long period)',
  dro: '遠距離逆行軌道(DRO)',
  dpo: '遠距離順行軌道(DPO)',
  lpo: '低高度順行軌道(LPO)',
};

const POINT_ORDER: Readonly<Record<string, number>> = { L1: 0, L2: 1, L3: 2, L4: 3, L5: 4 };
const BRANCH_ORDER: Readonly<Record<string, number>> = { N: 0, S: 1 };
const EW_ORDER: Readonly<Record<string, number>> = { E: 0, W: 1 };
// 群内での小題・standalone種類の並び順。
const COMBINED_BASE_ORDER: readonly string[] = [
  'lyapunov', 'vertical', 'axial', 'halo', 'short', 'longp', 'dpo', 'lpo',
];
const STANDALONE_BASE_ORDER: readonly string[] = ['butterfly', 'dragonfly', 'dro', 'resonant'];
const RESONANT_ORDER: readonly string[] = ['12', '21', '31', '23', '43', '34'];

export interface KindDef {
  readonly id: string; // 焼き込みカタログの族 id。settings.kinds のキーと一致する。
  readonly group: GuideGroupId;
  readonly label: string;
  readonly sortKey: number;
  readonly index: number;
}

export interface CombinedKindMember {
  readonly id: string;
  readonly point?: string;
  readonly branch?: 'N' | 'S';
  readonly ew?: 'E' | 'W';
  readonly segment: number;
}

export interface CombinedKindDef {
  readonly key: string; // `${group}-${base}`。settings.combinedKinds のキーと一致する。
  readonly group: GuideGroupId;
  readonly label: string;
  readonly axes: CombinedKindAxes;
  readonly members: readonly CombinedKindMember[]; // 実在するメンバーのみ、軸の順で整列済み
  readonly pointValues: readonly string[];
  readonly branchValues: readonly ('N' | 'S')[];
  readonly ewValues: readonly ('E' | 'W')[];
  readonly segmentValues: readonly number[];
  readonly index: number;
}

// standalone種類(蝶形・トンボ形・共鳴・DRO)の表示ラベルを組む。
function standaloneLabel(p: ParsedGuideKindId): string {
  const segmentLabel = p.segment > 0 ? ` 区間${p.segment}` : '';
  if (p.base === 'resonant') {
    const ratio = p.id.slice('resonant-'.length);
    return `${ratio[0]}:${ratio[1]}${segmentLabel}`;
  }
  if (p.base === 'dro') return `${BASE_LABELS['dro']}${segmentLabel}`;
  const branchLabel = p.branch === 'N' ? ' 北' : p.branch === 'S' ? ' 南' : '';
  return `${BASE_LABELS[p.base]} ${p.point ?? ''}${branchLabel}${segmentLabel}`;
}

// standalone種類の並び順キー。STANDALONE_BASE_ORDER・POINT_ORDER・BRANCH_ORDER・RESONANT_ORDER
// を基に、群内で昇順に比較できる1つの数値へ落とす。
function standaloneSortKey(p: ParsedGuideKindId): number {
  if (p.base === 'resonant') {
    const ratio = p.id.slice('resonant-'.length);
    const order = RESONANT_ORDER.indexOf(ratio);
    return (order < 0 ? 99 : order) * 10 + p.segment;
  }
  const baseOrder = STANDALONE_BASE_ORDER.indexOf(p.base);
  const pointIndex = p.point ? (POINT_ORDER[p.point] ?? 9) : 0;
  const branchOrder = p.branch ? (BRANCH_ORDER[p.branch] ?? 9) : 0;
  return baseOrder * 1000 + pointIndex * 100 + branchOrder * 10 + p.segment;
}

// 小題内でのメンバー(実在する族)の並び順キー。POINT_ORDER・BRANCH_ORDER・EW_ORDER と区間番号を
// 基に、昇順に比較できる1つの数値へ落とす。
function memberSortKey(m: CombinedKindMember): number {
  const pointIndex = m.point ? (POINT_ORDER[m.point] ?? 9) : 0;
  const branchOrder = m.branch ? (BRANCH_ORDER[m.branch] ?? 9) : 0;
  const ewOrder = m.ew ? (EW_ORDER[m.ew] ?? 9) : 0;
  return pointIndex * 1000 + branchOrder * 100 + ewOrder * 10 + m.segment;
}

// 重複を除いた値を order の並び順で昇順に整列する。order に無い値は末尾へ回す。
function uniqueSorted<T extends string>(values: readonly T[], order: Readonly<Record<string, number>>): readonly T[] {
  return [...new Set(values)].sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9));
}

// availableFamilies(系ごとの族 id 一覧)の和から、種類の行一覧を組む。並び順が決まった時点で
// index を振り、既定色(guideKindDefaultColors)の明度分けに使えるようにする。
export function buildKindDefs(availableFamilies: ReadonlyMap<CatalogSystemId, readonly string[]>): {
  readonly kinds: ReadonlyMap<GuideGroupId, readonly KindDef[]>;
  readonly combined: ReadonlyMap<GuideGroupId, readonly CombinedKindDef[]>;
} {
  const ids = new Set<string>();
  for (const list of availableFamilies.values()) for (const id of list) ids.add(id);

  const kindsByGroup = new Map<GuideGroupId, Omit<KindDef, 'index'>[]>();
  for (const group of GUIDE_GROUPS) kindsByGroup.set(group, []);

  interface CombinedAccum {
    readonly group: GuideGroupId;
    readonly base: string;
    readonly axes: CombinedKindAxes;
    readonly members: CombinedKindMember[];
  }
  const combinedByKey = new Map<string, CombinedAccum>();

  for (const id of ids) {
    const parsed = parseGuideKindId(id);
    if (parsed === null) continue;
    if (parsed.combinedKey === null) {
      kindsByGroup.get(parsed.group)!.push({
        id, group: parsed.group, label: standaloneLabel(parsed), sortKey: standaloneSortKey(parsed),
      });
      continue;
    }
    // combinedKey が非nullな行は必ず axes も非null(型では保証されない)。
    if (parsed.axes === null) continue;
    let accum = combinedByKey.get(parsed.combinedKey);
    if (accum === undefined) {
      accum = { group: parsed.group, base: parsed.base, axes: parsed.axes, members: [] };
      combinedByKey.set(parsed.combinedKey, accum);
    }
    accum.members.push({ id, point: parsed.point, branch: parsed.branch, ew: parsed.ew, segment: parsed.segment });
  }

  const kinds = new Map<GuideGroupId, readonly KindDef[]>();
  for (const [group, list] of kindsByGroup) {
    list.sort((a, b) => a.sortKey - b.sortKey);
    kinds.set(group, list.map((def, i) => ({ ...def, index: i })));
  }

  const combinedByGroup = new Map<GuideGroupId, Omit<CombinedKindDef, 'index'>[]>();
  for (const group of GUIDE_GROUPS) combinedByGroup.set(group, []);
  for (const [key, accum] of combinedByKey) {
    accum.members.sort((a, b) => memberSortKey(a) - memberSortKey(b));
    combinedByGroup.get(accum.group)!.push({
      key, group: accum.group, label: BASE_LABELS[accum.base] ?? accum.base, axes: accum.axes, members: accum.members,
      pointValues: uniqueSorted(accum.members.map((m) => m.point).filter((v): v is string => v !== undefined), POINT_ORDER),
      branchValues: uniqueSorted(accum.members.map((m) => m.branch).filter((v): v is 'N' | 'S' => v !== undefined), BRANCH_ORDER),
      ewValues: uniqueSorted(accum.members.map((m) => m.ew).filter((v): v is 'E' | 'W' => v !== undefined), EW_ORDER),
      segmentValues: [...new Set(accum.members.map((m) => m.segment))].sort((a, b) => a - b),
    });
  }
  const combined = new Map<GuideGroupId, readonly CombinedKindDef[]>();
  for (const [group, list] of combinedByGroup) {
    list.sort((a, b) => COMBINED_BASE_ORDER.indexOf(baseOfKey(a.key)) - COMBINED_BASE_ORDER.indexOf(baseOfKey(b.key)));
    combined.set(group, list.map((def, i) => ({ ...def, index: i })));
  }

  return { kinds, combined };
}

// combinedKey(`${group}-${base}`)から base 部分だけを取り出す。
function baseOfKey(key: string): string {
  return key.slice(key.indexOf('-') + 1);
}

// 群・小題内での並び順(index)と総数(count)から、種類の既定表示色(始・終)を返す。
export function defaultColorsFor(group: GuideGroupId, index: number, count: number): { readonly start: number; readonly end: number } {
  const [start, end] = guideKindDefaultColors(group, index, count);
  return { start, end };
}
