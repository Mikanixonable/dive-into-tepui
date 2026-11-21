// 敵の実験環境が出すスライダーの定義。値の正本は src/physics/assembly-tuning.ts の
// ASSEMBLY_TUNING_DEFAULTS で、ここは各項目の見出し・範囲・刻みと、画面でのまとまりだけを持つ。
import type { AssemblyTuningId } from '../../src/physics/assembly-tuning';

export interface TuningItem {
  readonly id: AssemblyTuningId;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export interface TuningGroup {
  readonly title: string;
  readonly note: string;
  readonly items: readonly TuningItem[];
}

export const TUNING_GROUPS: readonly TuningGroup[] = [
  {
    title: '大きさ',
    note: '個体の外接半径 [m]。範囲の中から個体ごとに一様に引く。',
    items: [
      { id: 'outerRadiusMin', label: '外接半径 下限', min: 10, max: 150, step: 1 },
      { id: 'outerRadiusMax', label: '外接半径 上限', min: 10, max: 150, step: 1 },
    ],
  },
  {
    title: '管',
    note: '管半径。歩行 1 ステップの長さを 1 とした値(個体は外接半径へ縮められるので、見た目の太さは形とも決まる)。',
    items: [
      { id: 'tubeRadiusMin', label: '管の太さ 下限', min: 0.02, max: 0.3, step: 0.005 },
      { id: 'tubeRadiusMax', label: '管の太さ 上限', min: 0.02, max: 0.3, step: 0.005 },
    ],
  },
  {
    title: '型',
    note: '結び目を全体の形に持つ個体の割合と、枝分かれ型に結び目部品が付く割合。',
    items: [
      { id: 'wholeKnotProbability', label: '全体が結び目', min: 0, max: 1, step: 0.01 },
      { id: 'localKnotProbability', label: '局所結び目が付く', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: '折れ曲がり',
    note: '管が1ステップで曲がる角度の上限 [rad]。',
    items: [{ id: 'walkTurnMax', label: '曲がりの上限', min: 0, max: 2, step: 0.02 }],
  },
  {
    title: '主鎖(枝分かれ型)',
    note: '主鎖の節数と、主鎖を分ける部品数。',
    items: [
      { id: 'spineStepsMin', label: '節数 下限', min: 1, max: 16, step: 1 },
      { id: 'spineStepsMax', label: '節数 上限', min: 1, max: 16, step: 1 },
      { id: 'spinePartsMin', label: '分割数 下限', min: 1, max: 8, step: 1 },
      { id: 'spinePartsMax', label: '分割数 上限', min: 1, max: 8, step: 1 },
    ],
  },
  {
    title: '枝(枝分かれ型)',
    note: '枝は 0 本から上限まで一様。振れ幅は主鎖の外向きからのずれ。',
    items: [
      { id: 'branchCountMax', label: '本数の上限', min: 0, max: 8, step: 1 },
      { id: 'branchStepsMin', label: '節数 下限', min: 1, max: 10, step: 1 },
      { id: 'branchStepsMax', label: '節数 上限', min: 1, max: 10, step: 1 },
      { id: 'branchSpread', label: '振れ幅', min: 0, max: 3, step: 0.05 },
      { id: 'localKnotScale', label: '局所結び目の大きさ', min: 0.2, max: 3, step: 0.05 },
    ],
  },
  {
    title: '結び目型',
    note: '閉ループを分ける部品数と、付属の枝。',
    items: [
      { id: 'wholeKnotPartsMin', label: '分割数 下限', min: 1, max: 6, step: 1 },
      { id: 'wholeKnotPartsMax', label: '分割数 上限', min: 1, max: 6, step: 1 },
      { id: 'wholeKnotBranchCountMax', label: '枝の本数の上限', min: 0, max: 6, step: 1 },
      { id: 'wholeKnotBranchStepsMin', label: '枝の節数 下限', min: 1, max: 8, step: 1 },
      { id: 'wholeKnotBranchStepsMax', label: '枝の節数 上限', min: 1, max: 8, step: 1 },
      { id: 'wholeKnotBranchSpread', label: '枝の振れ幅', min: 0, max: 3, step: 0.05 },
    ],
  },
];
