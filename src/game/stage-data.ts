import * as C from './const';

export type StageIndex = -1 | 0 | 1 | 2;

export interface StageInitData {
  magsLeft: number;
  roundsInMag: number;
  briefingHtml: string;
}

export type StageEnemyPreset =
  | { kind: 'phased'; name: string; dAlong: number; hp: number; accent: number }
  | { kind: 'coelliptic'; name: string; dAlong: number; altitudeOffset: number; hp: number; accent: number }
  | { kind: 'crossing'; name: string; dAlong: number; hp: number; accent: number }
  | { kind: 'elliptic'; name: string; dAlong: number; hp: number; accent: number }
  | { kind: 'molniya'; name: string; raan: number; nu: number; hp: number; accent: number };

export type StageEnemyLayout =
  | { kind: 'none' }
  | { kind: 'training-cluster' }
  | { kind: 'presets'; presets: StageEnemyPreset[] };

export type StageInitAction = 'none' | 'spawn-stage0-ammo' | 'spawn-stage00-ammo';

export interface StageDefinition {
  index: StageIndex;
  selectLabel: string;
  selectSub: string;
  selectLockedSub?: string;
  selectKeys: string[];
  requiresStage1Clear?: boolean;
  queryParam?: number;
  initialAmmo: Pick<StageInitData, 'magsLeft' | 'roundsInMag'>;
  briefingHtml: (enemyCount: number) => string;
  initAction: StageInitAction;
  enemyLayout: StageEnemyLayout;
}

export const DEFAULT_STAGE_INDEX: StageIndex = 1;

export const STAGE_DEFINITIONS: StageDefinition[] = [
  {
    index: -1,
    selectLabel: '[0] 無限耐久サバイバル (Stage 00)',
    selectSub: '常時選択可。弾薬を拾ってから始まる無限の波状攻撃。自機が破壊されるまで続く',
    selectKeys: ['Digit0'],
    initialAmmo: { magsLeft: C.INITIAL_MAGS - 1, roundsInMag: C.MAG_ROUNDS },
    briefingHtml: () =>
      '<b>サバイバル任務: 弾薬を回収し、無限の敵から生き残れ！</b><br>' +
      '敵は次々と波状攻撃を仕掛けてくる。<br>' +
      '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
      '[H] キーで操作方法を表示',
    initAction: 'spawn-stage00-ammo',
    enemyLayout: { kind: 'none' },
  },
  {
    index: 0,
    selectLabel: '[T] 訓練ステージ — 近接戦闘訓練 (Stage 0)',
    selectSub: '常時選択可。5km以内に色分けされた敵集団 約50機、制限時間2分の撃墜数スコアアタック',
    selectKeys: ['KeyT'],
    queryParam: 0,
    initialAmmo: { magsLeft: 0, roundsInMag: 0 },
    briefingHtml: () =>
      `<b>訓練ステージ: 制限時間 ${Math.floor(C.STAGE0_TIME_LIMIT / 60)}分で何機撃墜できるか</b><br>` +
      '周囲5km以内の色分けされた集団を撃墜せよ — RCS並進(WSADQE)と回転(IKJLUO)の練習に最適<br>' +
      '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
      '[H] キーで操作方法を表示',
    initAction: 'spawn-stage0-ammo',
    enemyLayout: { kind: 'training-cluster' },
  },
  {
    index: 1,
    selectLabel: '[1] 第一ステージ — LEO 戦域',
    selectSub: '高度420kmの低軌道。敵5機はすべて近傍軌道に分布',
    selectKeys: ['Digit1', 'Enter'],
    queryParam: 1,
    initialAmmo: { magsLeft: C.INITIAL_MAGS - 1, roundsInMag: C.MAG_ROUNDS },
    briefingHtml: (enemyCount) =>
      `<b>作戦目標: 敵機 ${enemyCount} 機を全機撃破せよ</b><br>` +
      '[Tab] ターゲット選択 → [F] ターゲット基準推進で接近 → [,/.] タイムワープで会合を短縮<br>' +
      '[H] キーで操作方法を表示',
    initAction: 'none',
    enemyLayout: {
      kind: 'presets',
      presets: [
        { kind: 'phased', name: 'HOSTILE-α', dAlong: 1400, hp: 2, accent: 0xff4a3d },
        { kind: 'coelliptic', name: 'HOSTILE-β', dAlong: -2800, altitudeOffset: 2500, hp: 2, accent: 0xff7a2d },
        { kind: 'crossing', name: 'HOSTILE-γ', dAlong: 2200, hp: 2, accent: 0xe0409f },
        { kind: 'elliptic', name: 'HOSTILE-δ', dAlong: 5000, hp: 3, accent: 0xbf3dff },
        { kind: 'phased', name: 'HOSTILE-ε', dAlong: 60000, hp: 3, accent: 0xff2d6b },
      ],
    },
  },
  {
    index: 2,
    selectLabel: '[2] 第二ステージ — モルニヤ戦域',
    selectSub: '敵は高楕円(モルニヤ級)軌道にも分布。軌道計画モード [M] での遷移が必須',
    selectLockedSub: '🔒 第一ステージをクリアすると解放',
    selectKeys: ['Digit2'],
    requiresStage1Clear: true,
    queryParam: 2,
    initialAmmo: { magsLeft: C.INITIAL_MAGS - 1, roundsInMag: C.MAG_ROUNDS },
    briefingHtml: (enemyCount) =>
      `<b>作戦目標: 敵機 ${enemyCount} 機を全機撃破せよ</b><br>` +
      '敵の一部はモルニヤ級の高楕円軌道上にいる — [M] 軌道計画モードで遷移を計画せよ<br>' +
      '[H] キーで操作方法を表示',
    initAction: 'none',
    enemyLayout: {
      kind: 'presets',
      presets: [
        { kind: 'phased', name: 'HOSTILE-α', dAlong: 1800, hp: 2, accent: 0xff4a3d },
        { kind: 'coelliptic', name: 'HOSTILE-β', dAlong: -2600, altitudeOffset: 3000, hp: 2, accent: 0xff7a2d },
        { kind: 'molniya', name: 'MOLNIYA-γ', raan: 0.4, nu: 2.6, hp: 3, accent: 0xe0409f },
        { kind: 'molniya', name: 'MOLNIYA-δ', raan: 2.5, nu: 0.9, hp: 3, accent: 0xbf3dff },
        { kind: 'molniya', name: 'MOLNIYA-ε', raan: 4.6, nu: 3.8, hp: 3, accent: 0xff2d6b },
      ],
    },
  },
];

const STAGE_BY_INDEX = new Map<StageIndex, StageDefinition>(STAGE_DEFINITIONS.map((stage) => [stage.index, stage]));

export function getStageDefinition(stage: number): StageDefinition {
  return STAGE_BY_INDEX.get(stage as StageIndex) ?? STAGE_BY_INDEX.get(DEFAULT_STAGE_INDEX)!;
}

export function resolveStageInitData(stage: number, enemyCount: number): StageInitData {
  const def = getStageDefinition(stage);
  return {
    magsLeft: def.initialAmmo.magsLeft,
    roundsInMag: def.initialAmmo.roundsInMag,
    briefingHtml: def.briefingHtml(enemyCount),
  };
}

export function resolveForcedStageFromQuery(stageParam: string | null): StageIndex | null {
  if (stageParam === null) return null;
  const forced = Number(stageParam);
  const matched = STAGE_DEFINITIONS.find((stage) => stage.queryParam === forced);
  return matched?.index ?? null;
}
