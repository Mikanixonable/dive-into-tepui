// 焼き込みカタログの族 id(`lyapunov-L1` `halo-L2-N` `axial-L1#2` `resonant-12` など)の命名規則。
// id を base/point/branch/ew/区間へ分解し、押された軸値の組み合わせから候補 id を組む。
import type { GuideGroupId } from './orbit-guide-settings';

// 区間番号を本体から区切る印。
const SEGMENT_MARK = '#';

// 小題(統合対象の base)が持つ軸の種類。
export interface CombinedKindAxes {
  readonly point: boolean;
  readonly branch: boolean;
  readonly ew: boolean;
  readonly segment: boolean;
}

// base ごとの軸。族の集合そのものはカタログ依存だが、base ごとにどの軸を持つかは命名規則で決まる。
const COMBINED_BASE_AXES: Readonly<Record<string, CombinedKindAxes>> = {
  lyapunov: { point: true, branch: false, ew: false, segment: false },
  vertical: { point: true, branch: false, ew: false, segment: false },
  axial: { point: true, branch: false, ew: false, segment: true },
  halo: { point: true, branch: true, ew: false, segment: false },
  short: { point: true, branch: false, ew: false, segment: false },
  longp: { point: true, branch: false, ew: false, segment: false },
  dpo: { point: false, branch: false, ew: false, segment: true },
  lpo: { point: false, branch: false, ew: true, segment: false },
};

export interface ParsedGuideKindId {
  readonly id: string;
  readonly group: GuideGroupId;
  readonly base: string;
  readonly point?: string; // 'L1'〜'L5'
  readonly branch?: 'N' | 'S';
  readonly ew?: 'E' | 'W';
  readonly segment: number; // 0 = 区間指定なし
  // 統合対象の base(COMBINED_BASE_AXES に載っている)なら `${group}-${base}`、
  // 対象外(蝶形・トンボ形・共鳴・DRO)なら null。
  readonly combinedKey: string | null;
  readonly axes: CombinedKindAxes | null;
}

// 族 id を group/base/point/branch/ew/区間へ分解する。未知の id・区間番号が規約に合わない
// id は null。
export function parseGuideKindId(id: string): ParsedGuideKindId | null {
  // 区間番号(#n)を本体から切り離す。
  const markIndex = id.indexOf(SEGMENT_MARK);
  const bodyId = markIndex < 0 ? id : id.slice(0, markIndex);
  const segmentText = markIndex < 0 ? '' : id.slice(markIndex + SEGMENT_MARK.length);
  let segment = 0;
  if (segmentText !== '') {
    const parsed = Number(segmentText);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    segment = parsed;
  }

  // 統合対象外の族は base ごとに固有の形を持つ。
  const parts = bodyId.split('-');
  const base = parts[0] as string;

  if (base === 'resonant') return { id, group: 'resonant', base, segment, combinedKey: null, axes: null };
  if (base === 'dro') return { id, group: 'secondary', base, segment, combinedKey: null, axes: null };
  if (base === 'butterfly' || base === 'dragonfly') {
    const point = parts[1];
    const branch = parts[2] as 'N' | 'S' | undefined;
    if (point === undefined || branch === undefined) return null;
    return { id, group: 'collinear', base, point, branch, segment, combinedKey: null, axes: null };
  }

  // 統合対象の族は、base が持つ軸の並びで読む。
  const axes = COMBINED_BASE_AXES[base];
  if (axes === undefined) return null; // 未知の族 id

  if (base === 'dpo') return { id, group: 'secondary', base, segment, combinedKey: 'secondary-dpo', axes };
  if (base === 'lpo') {
    const ew = parts[1] as 'E' | 'W' | undefined;
    if (ew === undefined) return null;
    return { id, group: 'secondary', base, ew, segment, combinedKey: 'secondary-lpo', axes };
  }

  // ラグランジュ点を持つ族。群は base と点の種類で決まる。
  const point = parts[1];
  if (point === undefined) return null;
  const isTriangularPoint = point === 'L4' || point === 'L5';
  const group: GuideGroupId = base === 'short' || base === 'longp' || isTriangularPoint ? 'triangular' : 'collinear';

  if (axes.branch) {
    const branch = parts[2] as 'N' | 'S' | undefined;
    if (branch === undefined) return null;
    return { id, group, base, point, branch, segment, combinedKey: `${group}-${base}`, axes };
  }
  return { id, group, base, point, segment, combinedKey: `${group}-${base}`, axes };
}

// parseGuideKindId の逆変換。軸値の組から id を組む。組んだ id がカタログに実在するとは限らない。
function buildCombinedId(
  base: string, point: string | undefined, branch: 'N' | 'S' | undefined, ew: 'E' | 'W' | undefined,
  segment: number,
): string {
  const body = [base, point ?? ew, branch].filter((v): v is string => v !== undefined).join('-');
  return segment > 0 ? `${body}${SEGMENT_MARK}${segment}` : body;
}

// 各軸が取りうる値。
const POINT_VALUES: readonly string[] = ['L1', 'L2', 'L3', 'L4', 'L5'];
const BRANCH_VALUES: readonly ('N' | 'S')[] = ['N', 'S'];
const EW_VALUES: readonly ('E' | 'W')[] = ['E', 'W'];

// 押されている軸値を、軸の種類ごとに分けたもの。
interface PressedAxisValues {
  readonly points: readonly string[];
  readonly branches: readonly ('N' | 'S')[];
  readonly ews: readonly ('E' | 'W')[];
  readonly segments: readonly number[];
}

// axisValues(キーは軸値の生コード)を軸の種類ごとに仕分ける。
function pressedAxisValues(axisValues: Readonly<Record<string, boolean>>): PressedAxisValues {
  const points: string[] = [];
  const branches: ('N' | 'S')[] = [];
  const ews: ('E' | 'W')[] = [];
  const segments: number[] = [];
  for (const [value, on] of Object.entries(axisValues)) {
    if (!on) continue;
    if (POINT_VALUES.includes(value)) points.push(value);
    else if (value === 'N' || value === 'S') branches.push(value);
    else if (value === 'E' || value === 'W') ews.push(value);
    else if (/^\d+$/.test(value)) segments.push(Number(value));
  }
  return { points, branches, ews, segments };
}

// axisValues(押されている軸値の集合)から、その小題が持つ軸だけを直積して候補 id を組む。組んだ id
// がカタログに実在するとは限らない。何も押されていなければ候補は無い。点・南北・東西は、他の軸を
// 1つでも押していれば、自分が空でも「その軸の全値」を対象にする(例: ハローで南北だけ押すと L1〜L3
// すべての南北が対象になる)。区間は物理的に別系統の族なので、押した区間だけが対象。
export function combinedCandidateIds(
  combinedKey: string, axisValues: Readonly<Record<string, boolean>>,
): readonly string[] {
  const base = combinedKey.slice(combinedKey.indexOf('-') + 1);
  const axes = COMBINED_BASE_AXES[base];
  if (axes === undefined) return [];
  const pressed = pressedAxisValues(axisValues);

  // 何も押していない・区間軸を持つのに区間を押していないなら候補は無い。
  const anyPressed = pressed.points.length > 0 || pressed.branches.length > 0
    || pressed.ews.length > 0 || pressed.segments.length > 0;
  if (!anyPressed) return [];
  if (axes.segment && pressed.segments.length === 0) return [];

  // 軸ごとの値の並び。持たない軸は空値 1 つ。
  const points = axes.point ? (pressed.points.length > 0 ? pressed.points : POINT_VALUES) : [undefined];
  const branches = axes.branch ? (pressed.branches.length > 0 ? pressed.branches : BRANCH_VALUES) : [undefined];
  const ews = axes.ew ? (pressed.ews.length > 0 ? pressed.ews : EW_VALUES) : [undefined];
  const segments = axes.segment ? pressed.segments : [0];

  // 直積。
  const ids: string[] = [];
  for (const point of points) {
    for (const branch of branches) {
      for (const ew of ews) {
        for (const segment of segments) {
          ids.push(buildCombinedId(base, point, branch, ew, segment));
        }
      }
    }
  }
  return ids;
}
