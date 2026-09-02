// 焼き込みカタログの族 id(`lyapunov-L1` `halo-L2-N` `axial-L1#2` `resonant-12` など)を
// base/point/branch/ew/区間へ分解する。HUD層(guide-kind-def.ts、表示名・ボタン生成)と
// celestial層(orbit-guide-lines.ts、設定解決)の双方が使うため、依存が celestial → hud へ
// 逆流しないようここへ置く。
import type { GuideGroupId } from './orbit-guide-settings';

const SEGMENT_MARK = '#';

// 小題(統合対象の base)が持つ軸の種類。族の集合そのものはカタログ依存だが、base ごとに
// どの軸を持つかは命名規則で決まる構造的な事実(既存の BASE_LABELS 等と同種の固定テーブル)。
const COMBINED_BASE_AXES: Readonly<Record<string, { point: boolean; branch: boolean; ew: boolean; segment: boolean }>> = {
  lyapunov: { point: true, branch: false, ew: false, segment: false },
  vertical: { point: true, branch: false, ew: false, segment: false },
  axial: { point: true, branch: false, ew: false, segment: true },
  halo: { point: true, branch: true, ew: false, segment: false },
  short: { point: true, branch: false, ew: false, segment: false },
  longp: { point: true, branch: false, ew: false, segment: false },
  dpo: { point: false, branch: false, ew: false, segment: true },
  lpo: { point: false, branch: false, ew: true, segment: false },
};

export interface CombinedKindAxes {
  readonly point: boolean;
  readonly branch: boolean;
  readonly ew: boolean;
  readonly segment: boolean;
}

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
  const markIndex = id.indexOf(SEGMENT_MARK);
  const bodyId = markIndex < 0 ? id : id.slice(0, markIndex);
  const segmentText = markIndex < 0 ? '' : id.slice(markIndex + SEGMENT_MARK.length);
  let segment = 0;
  if (segmentText !== '') {
    const parsed = Number(segmentText);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    segment = parsed;
  }

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

  const axes = COMBINED_BASE_AXES[base];
  if (axes === undefined) return null; // 未知の族 id

  if (base === 'dpo') return { id, group: 'secondary', base, segment, combinedKey: 'secondary-dpo', axes };
  if (base === 'lpo') {
    const ew = parts[1] as 'E' | 'W' | undefined;
    if (ew === undefined) return null;
    return { id, group: 'secondary', base, ew, segment, combinedKey: 'secondary-lpo', axes };
  }

  const point = parts[1];
  if (point === undefined) return null;
  const isTriangularPoint = point === 'L4' || point === 'L5';
  let group: GuideGroupId;
  if (base === 'short' || base === 'longp') group = 'triangular';
  else group = isTriangularPoint ? 'triangular' : 'collinear';

  if (axes.branch) {
    const branch = parts[2] as 'N' | 'S' | undefined;
    if (branch === undefined) return null;
    return { id, group, base, point, branch, segment, combinedKey: `${group}-${base}`, axes };
  }
  return { id, group, base, point, segment, combinedKey: `${group}-${base}`, axes };
}

// parseGuideKindId の逆変換。combinedKey 側で押されている軸値の組み合わせから候補 id を組む
// (実在するかどうかは呼び出し側がカタログで確かめる)。
function buildCombinedId(
  base: string, parts: { readonly point?: string; readonly branch?: 'N' | 'S'; readonly ew?: 'E' | 'W'; readonly segment: number },
): string {
  const body = [base, parts.point ?? parts.ew, parts.branch].filter((v): v is string => v !== undefined).join('-');
  return parts.segment > 0 ? `${body}${SEGMENT_MARK}${parts.segment}` : body;
}

// 小題 id からその小題が持つ軸を引く。未知の小題 id なら null。
function axesFor(combinedKey: string): CombinedKindAxes | null {
  const base = combinedKey.slice(combinedKey.indexOf('-') + 1);
  return COMBINED_BASE_AXES[base] ?? null;
}

const POINT_VALUES: readonly string[] = ['L1', 'L2', 'L3', 'L4', 'L5'];
const BRANCH_VALUES: readonly ('N' | 'S')[] = ['N', 'S'];
const EW_VALUES: readonly ('E' | 'W')[] = ['E', 'W'];

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
    if ((POINT_VALUES as readonly string[]).includes(value)) points.push(value);
    else if (value === 'N' || value === 'S') branches.push(value);
    else if (value === 'E' || value === 'W') ews.push(value);
    else if (/^\d+$/.test(value)) segments.push(Number(value));
  }
  return { points, branches, ews, segments };
}

// axisValues(押されている軸値の集合)から、その小題が持つ軸だけを直積して候補 id を組む。
// 実在するかどうかは呼び出し側がカタログで確かめる。何も押されていなければ候補は無い。
// 点・南北・東西は、他の軸を1つでも押していれば、自分が空でも「その軸の全値」を対象にする
// (例: ハローで南北だけ押すと L1〜L3 すべての南北が対象になる)。区間だけは物理的に別系統の
// 族なので、この自動補完の対象にしない(押した区間だけが対象)。
export function combinedCandidateIds(combinedKey: string, axisValues: Readonly<Record<string, boolean>>): readonly string[] {
  const axes = axesFor(combinedKey);
  if (axes === null) return [];
  const base = combinedKey.slice(combinedKey.indexOf('-') + 1);
  const pressed = pressedAxisValues(axisValues);

  const anyPressed = pressed.points.length > 0 || pressed.branches.length > 0
    || pressed.ews.length > 0 || pressed.segments.length > 0;
  if (!anyPressed) return [];
  if (axes.segment && pressed.segments.length === 0) return [];

  const points = axes.point ? (pressed.points.length > 0 ? pressed.points : POINT_VALUES) : [undefined];
  const branches = axes.branch ? (pressed.branches.length > 0 ? pressed.branches : BRANCH_VALUES) : [undefined];
  const ews = axes.ew ? (pressed.ews.length > 0 ? pressed.ews : EW_VALUES) : [undefined];
  const segments = axes.segment ? pressed.segments : [0];

  const ids: string[] = [];
  for (const point of points) {
    for (const branch of branches) {
      for (const ew of ews) {
        for (const segment of segments) {
          ids.push(buildCombinedId(base, { point, branch, ew, segment }));
        }
      }
    }
  }
  return ids;
}
