// ステージ配列(STAGE_DEFINITIONS)の定義を責務とする — 各ステージの init/update/checkWin/onWin は
// ここに直接書くが、複数ステージにまたがる/大きくなった処理(stage00 の波状攻撃管理は wave-manager.ts、
// stage0 のスコアアタックタイマーは score-attack-timer.ts)は別モジュールへ切り出し、ここでは呼ぶだけにする。
import * as C from './const';
import { Hud } from '../hud/hud';
import { Sfx } from '../audio/sfx';
import { showScoreAttackResultScreen, showWinScreen } from './result-screen';
import type { StageCtx } from './stage-director';
import type { ClearCounts } from './unlock-manager';
import {
  generateCoellipticEnemy,
  generateCrossingEnemy,
  generateEllipticEnemy,
  generateMolniyaEnemy,
  generatePhasedEnemy,
} from './enemy/enemy-generator';
import { generateCluster } from './enemy/enemy-spawner';

export type StageIndex = -1 | 0 | 1 | 2;

export interface StageInitData {
  magsLeft: number;
  roundsInMag: number;
  briefingHtml: string;
}

// 撃破による勝利判定(checkWin/onWin)が必要とする最小の集計スナップショット。
export interface StageWinCtx {
  kills: number;
  losses: number;
  totalEnemies: number;
  shots: number;
  hits: number;
  simTime: number;
}

export interface StageDefinition {
  index: StageIndex;
  selectLabel: string;
  selectSub: string;
  selectLockedSub?: string;
  selectKeys: string[];
  // 省略時は常に解放。unlock-manager.ts が記録するクリア回数だけを条件式の引数として渡す
  // (localStorage 等の永続化には一切触れない)。
  isUnlocked?(clearCounts: ClearCounts): boolean;
  initialAmmo: Pick<StageInitData, 'magsLeft' | 'roundsInMag'>;
  briefingHtml: (enemyCount: number) => string;
  // ステージ開始時の処理(初期敵配置・初期補給投入)。戻り値は初期敵数(ブリーフィング表示用)。
  init(ctx: StageCtx): number;
  // 毎フレームの処理(弾薬兵站・タイマー・ウェーブ生成など、このステージに必要な分だけ書く)。
  update(dt: number, ctx: StageCtx): void;
  // 撃破数による勝利条件。時間切れ(ステージ0)は update 内で自己完結するのでここには含めない。
  checkWin(ctx: StageWinCtx): boolean;
  onWin(ctx: StageWinCtx, hud: Hud, sfx: Sfx): void;
}

export const DEFAULT_STAGE_INDEX: StageIndex = 1;

// 敵全機撃破(再突入等の自然損耗は losses を差し引くためだけに使う)による勝利判定。
function checkWinByKills(ctx: StageWinCtx): boolean {
  return ctx.totalEnemies - ctx.kills - ctx.losses <= 0;
}

function neverWinsByKills(): boolean { return false; }
function noWinScreen(): void { /* no-op: このステージは撃破数では終わらない */ }
function onWinByKills(ctx: StageWinCtx, hud: Hud, sfx: Sfx): void { showWinScreen(hud, sfx, ctx); }

// 訓練クラスタを生成してステージに登録する(配置計算・Enemy 生成は enemy-spawner.ts の責務)。
function spawnTrainingCluster(ctx: StageCtx): number {
  const enemies = generateCluster(ctx.player.state, ctx.scene);
  for (const enemy of enemies) ctx.addEnemy(enemy, 0x565b63);
  return enemies.length;
}

// ============================================================ ステージ定義

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
    init: (ctx) => {
      for (let i = 0; i < C.MAX_MAG_PICKUPS; i++) {
        ctx.ammoResupply.spawnForPlayer(ctx.player, C.STAGE00_AMMO_MIN_DIST, C.STAGE00_AMMO_MAX_DIST);
      }
      ctx.stageState.waveManager.spawnWave(ctx, 'random'); // 初期状態でもランダムに敵を配置する
      return 0;
    },
    update: (dt, ctx) => ctx.stageState.waveManager.update(dt, ctx, {
      spawnDelay: C.STAGE00_SPAWN_DELAY,
      spawnInterval: C.STAGE00_SPAWN_INTERVAL,
      maxRange: C.STAGE00_MAX_RANGE,
      respawnAmmoOnDespawn: true,
    }),
    checkWin: neverWinsByKills,
    onWin: noWinScreen,
  },
  {
    index: 0,
    selectLabel: '[T] 訓練ステージ — 近接戦闘訓練 (Stage 0)',
    selectSub: '常時選択可。5km以内に色分けされた敵集団 約50機、制限時間2分の撃墜数スコアアタック',
    selectKeys: ['KeyT'],
    initialAmmo: { magsLeft: 0, roundsInMag: 0 },
    briefingHtml: () =>
      `<b>訓練ステージ: 制限時間 ${Math.floor(C.STAGE0_TIME_LIMIT / 60)}分で何機撃墜できるか</b><br>` +
      '周囲5km以内の色分けされた集団を撃墜せよ — RCS並進(WSADQE)と回転(IKJLUO)の練習に最適<br>' +
      '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
      '[H] キーで操作方法を表示',
    init: (ctx) => {
      for (let i = 0; i < C.STAGE0_AMMO_PICKUPS; i++) {
        ctx.ammoResupply.spawnForPlayer(ctx.player, C.STAGE0_AMMO_MIN_DIST, C.STAGE0_AMMO_MAX_DIST);
      }
      return spawnTrainingCluster(ctx);
    },
    update: (dt, ctx) => {
      ctx.ammoResupply.updateLogistics(ctx.simTime, ctx.player);

      const stageTimer = ctx.stageState.scoreAttackTimer;
      if (stageTimer.update(dt, ctx.setPhase)) {
        showScoreAttackResultScreen(ctx.hud, ctx.sfx, ctx, 'TIME UP');
      }
    },
    checkWin: neverWinsByKills, // 終了は update 内のタイムアップ判定(撃破数では終わらない)
    onWin: noWinScreen,
  },
  {
    index: 1,
    selectLabel: '[1] 第一ステージ — LEO 戦域',
    selectSub: '高度420kmの低軌道。敵5機はすべて近傍軌道に分布',
    selectKeys: ['Digit1', 'Enter'],
    initialAmmo: { magsLeft: C.INITIAL_MAGS - 1, roundsInMag: C.MAG_ROUNDS },
    briefingHtml: (enemyCount) =>
      `<b>作戦目標: 敵機 ${enemyCount} 機を全機撃破せよ</b><br>` +
      '[Tab] ターゲット選択 → [F] ターゲット基準推進で接近 → [,/.] タイムワープで会合を短縮<br>' +
      '[H] キーで操作方法を表示',
    init: (ctx) => {
      const base = ctx.player.state;
      const scene = ctx.scene;
      ctx.addEnemy(generatePhasedEnemy('HOSTILE-α', base, 1400, 2, 0xff4a3d, scene), 0x565b63);
      ctx.addEnemy(generateCoellipticEnemy('HOSTILE-β', base, -2800, 2500, 2, 0xff7a2d, scene), 0x565b63);
      ctx.addEnemy(generateCrossingEnemy('HOSTILE-γ', base, 2200, 2, 0xe0409f, scene), 0x565b63);
      ctx.addEnemy(generateEllipticEnemy('HOSTILE-δ', base, 5000, 3, 0xbf3dff, scene), 0x565b63);
      ctx.addEnemy(generatePhasedEnemy('HOSTILE-ε', base, 60000, 3, 0xff2d6b, scene), 0x565b63);
      return 5;
    },
    update: (_dt, ctx) => ctx.ammoResupply.updateLogistics(ctx.simTime, ctx.player),
    checkWin: checkWinByKills,
    onWin: onWinByKills,
  },
  {
    index: 2,
    selectLabel: '[2] 第二ステージ — モルニヤ戦域',
    selectSub: '敵は高楕円(モルニヤ級)軌道にも分布。軌道計画モード [M] での遷移が必須',
    selectLockedSub: '🔒 第一ステージをクリアすると解放',
    selectKeys: ['Digit2'],
    isUnlocked: (clearCounts) => (clearCounts[1] ?? 0) > 0,
    initialAmmo: { magsLeft: C.INITIAL_MAGS - 1, roundsInMag: C.MAG_ROUNDS },
    briefingHtml: (enemyCount) =>
      `<b>作戦目標: 敵機 ${enemyCount} 機を全機撃破せよ</b><br>` +
      '敵の一部はモルニヤ級の高楕円軌道上にいる — [M] 軌道計画モードで遷移を計画せよ<br>' +
      '[H] キーで操作方法を表示',
    init: (ctx) => {
      const base = ctx.player.state;
      const scene = ctx.scene;
      ctx.addEnemy(generatePhasedEnemy('HOSTILE-α', base, 1800, 2, 0xff4a3d, scene), 0x565b63);
      ctx.addEnemy(generateCoellipticEnemy('HOSTILE-β', base, -2600, 3000, 2, 0xff7a2d, scene), 0x565b63);
      ctx.addEnemy(generateMolniyaEnemy('MOLNIYA-γ', 0.4, 2.6, 3, 0xe0409f, scene), 0x565b63);
      ctx.addEnemy(generateMolniyaEnemy('MOLNIYA-δ', 2.5, 0.9, 3, 0xbf3dff, scene), 0x565b63);
      ctx.addEnemy(generateMolniyaEnemy('MOLNIYA-ε', 4.6, 3.8, 3, 0xff2d6b, scene), 0x565b63);
      return 5;
    },
    update: (_dt, ctx) => ctx.ammoResupply.updateLogistics(ctx.simTime, ctx.player),
    checkWin: checkWinByKills,
    onWin: onWinByKills,
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
  const matched = STAGE_DEFINITIONS.find((stage) => stage.index === forced);
  return matched?.index ?? null;
}
