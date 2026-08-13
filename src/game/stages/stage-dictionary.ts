// ステージ一覧の定義: コンストラクタ列挙・ID引き・buildStage によるステージ初期化。
import * as THREE from 'three/webgpu';
import { Stage, StageId } from './stage';
import type { Player } from '../player/player';
import type { EntityManager } from '../simulation/entity-manager';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import type { UnlockManager } from '../unlock-manager';
import type { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import type { Ephemeris } from '../../physics/ephemeris';
import type { Simulator } from '../simulation/simulator';
import type { CelestialRegistry } from '../../physics/solar-system';
import type { AttractorId } from '../../physics/attractor';
import type { ActivePlayerController } from '../active-player-controller';
import type { StageSaveData } from '../save-data';
import { Stage00 } from './stage00';
import { Stage0 } from './stage0';
import { Stage1 } from './stage1';
import { Stage2 } from './stage2';
import { StageDebug } from './stage-debug';
import { StageDebugAltSystem } from './stage-debug-alt-system';
import { StageDebugLoad } from './stage-debug-load';
import { CreativeStage } from './creative-stage';

export const DEFAULT_STAGE_ID: StageId = '1';

// Ephemeris のコンストラクタ3引数をそのまま束ねた静的宣言。省略したステージは既定の
// レジストリ・地球原点のまま動く。
export type EphemerisConfig = {
  readonly registry: CelestialRegistry;
  readonly originId: AttractorId;
  readonly epochOffsetSec: number;
};

// ステージクラスが静的に宣言できる起動時の設定。省略した項目は既定値で動く。
interface StageStatics {
  readonly ephemerisConfig?: EphemerisConfig;
  // 新規開始時に組む自機の隻数。省略時は1隻。
  readonly initialPlayerCount?: number;
  // マップ視点でも艦のステータスパネルを表示するか。省略時は false(戦闘ビューのみ)。
  readonly showsStatusInOverview?: boolean;
}

interface StageClass extends StageStatics {
  readonly id: StageId;
  new (saved?: StageSaveData): Stage;
}

const STAGE_CLASSES: readonly StageClass[] = [Stage00, Stage0, Stage1, Stage2, StageDebug, StageDebugAltSystem, StageDebugLoad, CreativeStage];

// 選択画面のラベル・解放判定用の読み取り専用一覧。
export const STAGE_DEFINITIONS: readonly Stage[] = STAGE_CLASSES.map((StageClass) => new StageClass());

// id からステージを新規生成し、setup まで済ませて返す。saved 省略時のみ初期配置(init)を走らせる
// — スナップショットからの再開では敵・補給・弾薬は復元済み。艦が0隻のステージでは player が
// null になり、init は既定どおり何も置かない。
export function buildStage(
  stageId: StageId,
  player: Player | null,
  entities: EntityManager,
  hud: Hud,
  sfx: Sfx,
  scene: THREE.Scene,
  unlockManager: UnlockManager,
  fx: EffectsSystem,
  markerManager: MarkerManager,
  ephemeris: Ephemeris,
  simulator: Simulator,
  activePlayers: ActivePlayerController,
  saved?: StageSaveData,
): Stage {
  const StageClass = STAGE_CLASSES.find((c) => c.id === stageId) ?? STAGE_CLASSES.find((c) => c.id === DEFAULT_STAGE_ID)!;
  const stage = new StageClass(saved);
  stage.setup(hud, sfx, scene, entities, unlockManager, fx, markerManager, ephemeris, simulator, activePlayers);
  if (saved === undefined) {
    const enemyCount = stage.init(player, entities);
    player?.initAmmo(stage.initialAmmo.mags, stage.initialAmmo.rounds);
    hud.toast(stage.briefingHtml(enemyCount), 12000);
  }
  return stage;
}

// クエリパラメータ等、外部由来の未検証文字列を StageId に絞り込む型ガード。
export function isStageId(value: string | null): value is StageId {
  return STAGE_CLASSES.some((c) => c.id === value);
}

// stageId が指すステージクラスの静的宣言を引く。
function stageStaticsFor(stageId: StageId): StageStatics | undefined {
  return STAGE_CLASSES.find((c) => c.id === stageId);
}

// stageId が指すステージクラスの静的 ephemerisConfig。宣言が無ければ undefined(Ephemeris の
// コンストラクタ既定値どおり、既定レジストリ・地球原点で構築される)。
export function ephemerisConfigFor(stageId: StageId): EphemerisConfig | undefined {
  return stageStaticsFor(stageId)?.ephemerisConfig;
}

// stageId が指すステージクラスの静的 initialPlayerCount(省略時1)。
export function initialPlayerCountFor(stageId: StageId): number {
  return stageStaticsFor(stageId)?.initialPlayerCount ?? 1;
}

// stageId が指すステージクラスの静的 showsStatusInOverview(省略時 false)。
export function showsStatusInOverviewFor(stageId: StageId): boolean {
  return stageStaticsFor(stageId)?.showsStatusInOverview ?? false;
}
