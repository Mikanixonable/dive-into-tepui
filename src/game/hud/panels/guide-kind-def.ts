// 焼き込みカタログの族 id(`lyapunov-L1` `halo-L2-N` `resonant-12` など)を、画面に出す群・
// 表示名・並び順へ写す。名前は DEVELOP/SPEC/MAP.md 5.2 の表が正本で、日本語訳に英語を添える。
// 族の集合そのものは推測せず、呼び出し側から渡された実在の id だけを解釈する。
import { guideKindDefaultColors } from '../../const';
import type { CatalogSystemId } from '../../../physics/orbit-catalog';
import { GUIDE_GROUPS, type GuideGroupId } from '../../celestial/orbit-guide-settings';

// ---- 族 id → 画面表示の対応 -------------------------------------------------------------

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

// 区間つき族 id の区切り。正本は tools/orbit-family.mjs の SEGMENT_MARK(`'#'`)。
// tools/ は TypeScript のビルド対象外のため import せず、ここに複製する。
const SEGMENT_MARK = '#';

const POINT_ORDER: Readonly<Record<string, number>> = { L1: 0, L2: 1, L3: 2, L4: 3, L5: 4 };
const BRANCH_ORDER: Readonly<Record<string, number>> = { N: 0, S: 1 };
const EW_ORDER: Readonly<Record<string, number>> = { E: 0, W: 1 };
const BASE_ORDER_COLLINEAR: readonly string[] = ['lyapunov', 'vertical', 'halo', 'axial', 'butterfly', 'dragonfly'];
const BASE_ORDER_TRIANGULAR: readonly string[] = ['short', 'longp', 'vertical', 'axial'];
const BASE_ORDER_SECONDARY: readonly string[] = ['dro', 'dpo', 'lpo'];
const RESONANT_ORDER: readonly string[] = ['12', '21', '31', '23', '43', '34'];

export interface KindDef {
  readonly id: string; // 焼き込みカタログの族 id。settings.kinds のキーと一致する。
  readonly group: GuideGroupId;
  readonly label: string;
  readonly sortKey: number;
  // 群内での並び順(0始まり)。guideKindDefaultColors の明度分けに使う。buildKindDefs が
  // ソート後に埋める。
  index: number;
}

// 族 id を base/point/branch(または東西/比)へ分解し、群・表示名・並び順を決める。
// short/longp は L4/L5、axial/vertical/halo/lyapunov/butterfly/dragonfly は点で群が変わる。
function defineKind(id: string): KindDef | null {
  // 区間番号を切り離してから、残りを base/point/branch へ分解する。区間の無い id は
  // segmentLabel が空文字・segment が 0 のままになり、表示・sortKey とも従来どおりになる。
  const markIndex = id.indexOf(SEGMENT_MARK);
  const bodyId = markIndex < 0 ? id : id.slice(0, markIndex);
  const segmentText = markIndex < 0 ? '' : id.slice(markIndex + SEGMENT_MARK.length);
  let segment = 0;
  let segmentLabel = '';
  if (segmentText !== '') {
    const parsed = Number(segmentText);
    if (!Number.isInteger(parsed) || parsed < 1) return null; // 規約に合わない区間番号は無視する。
    segment = parsed;
    segmentLabel = ` 区間${parsed}`;
  }

  const parts = bodyId.split('-');
  const base = parts[0] as string;

  if (base === 'resonant') {
    const ratio = parts[1] ?? '';
    const order = RESONANT_ORDER.indexOf(ratio);
    return { id, group: 'resonant', label: `${ratio[0]}:${ratio[1]} 共鳴軌道${segmentLabel}`, sortKey: (order < 0 ? 99 : order) * 10 + segment, index: 0 };
  }

  if (base === 'lpo') {
    const ew = parts[1] ?? '';
    const ewLabel = ew === 'E' ? '東' : ew === 'W' ? '西' : ew;
    return {
      id, group: 'secondary', label: `${BASE_LABELS['lpo']} ${ewLabel}${segmentLabel}`,
      sortKey: BASE_ORDER_SECONDARY.indexOf('lpo') * 100 + (EW_ORDER[ew] ?? 9) * 10 + segment, index: 0,
    };
  }
  if (base === 'dro' || base === 'dpo') {
    return {
      id, group: 'secondary', label: `${BASE_LABELS[base] as string}${segmentLabel}`,
      sortKey: BASE_ORDER_SECONDARY.indexOf(base) * 100 + segment, index: 0,
    };
  }

  const baseLabel = BASE_LABELS[base];
  if (baseLabel === undefined) return null; // 未知の族 id は静かに無視する。
  const point = parts[1] ?? '';
  const branch = parts[2] ?? '';
  const pointIndex = POINT_ORDER[point];
  if (pointIndex === undefined) return null;
  const isTriangularPoint = point === 'L4' || point === 'L5';
  let group: GuideGroupId;
  let baseOrder: number;
  if (base === 'short' || base === 'longp') {
    group = 'triangular';
    baseOrder = BASE_ORDER_TRIANGULAR.indexOf(base);
  } else if (isTriangularPoint) {
    group = 'triangular';
    baseOrder = BASE_ORDER_TRIANGULAR.indexOf(base);
  } else {
    group = 'collinear';
    baseOrder = BASE_ORDER_COLLINEAR.indexOf(base);
  }
  const branchLabel = branch === 'N' ? ' 北' : branch === 'S' ? ' 南' : '';
  const branchOrder = branch === '' ? 0 : (BRANCH_ORDER[branch] ?? 9);
  return {
    id, group, label: `${baseLabel} ${point}${branchLabel}${segmentLabel}`,
    sortKey: baseOrder * 1000 + pointIndex * 100 + branchOrder * 10 + segment, index: 0,
  };
}

// availableFamilies(系ごとの族 id 一覧)の和から、種類の行一覧を群ごとに組む。並び順が
// 決まった時点で index を振り、既定色(guideKindDefaultColors)の明度分けに使えるようにする。
export function buildKindDefs(availableFamilies: ReadonlyMap<CatalogSystemId, readonly string[]>): ReadonlyMap<GuideGroupId, readonly KindDef[]> {
  const ids = new Set<string>();
  for (const list of availableFamilies.values()) for (const id of list) ids.add(id);
  const byGroup = new Map<GuideGroupId, KindDef[]>();
  for (const group of GUIDE_GROUPS) byGroup.set(group, []);
  for (const id of ids) {
    const def = defineKind(id);
    if (def === null) continue;
    (byGroup.get(def.group) as KindDef[]).push(def);
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => a.sortKey - b.sortKey);
    list.forEach((def, i) => { def.index = i; });
  }
  return byGroup;
}

// 種類の既定色(始・終)。群の色相・群内の明度分けは const.ts の guideKindDefaultColors
// (静止軌道リング等ほかの軌道線と同じ既定色ロジック)をそのまま使う。
export function defaultColorsFor(group: GuideGroupId, index: number, count: number): { readonly start: number; readonly end: number } {
  const [start, end] = guideKindDefaultColors(group, index, count);
  return { start, end };
}

// ---- 値入力の写像(スライダー⇔数値⇔設定値) ----------------------------------------------
