// ステージ一覧の定義: コンストラクタ列挙・ID引き・initStage によるステージ初期化。
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
import { Stage00 } from './stage00';
import { Stage0 } from './stage0';
import { Stage1 } from './stage1';
import { Stage2 } from './stage2';
import { StageDebug } from './stage-debug';

export const DEFAULT_STAGE_ID: StageId = '1';

interface StageClass {
  readonly id: StageId;
  new (): Stage;
}

const STAGE_CLASSES: readonly StageClass[] = [Stage00, Stage0, Stage1, Stage2, StageDebug];

// 選択画面のラベル・解放判定用の読み取り専用一覧。
export const STAGE_DEFINITIONS: readonly Stage[] = STAGE_CLASSES.map((StageClass) => new StageClass());

// id からステージを新規生成し、setup/init まで済ませて返す。
export function initStage(
  stageId: StageId,
  player: Player,
  entities: EntityManager,
  hud: Hud,
  sfx: Sfx,
  scene: THREE.Scene,
  unlockManager: UnlockManager,
  fx: EffectsSystem,
  markerManager: MarkerManager,
  ephemeris: Ephemeris,
): Stage {
  const StageClass = STAGE_CLASSES.find((c) => c.id === stageId) ?? STAGE_CLASSES.find((c) => c.id === DEFAULT_STAGE_ID)!;
  const stage = new StageClass();
  stage.setup(hud, sfx, scene, entities, unlockManager, fx, markerManager, ephemeris);
  const enemyCount = stage.init(player, entities);
  player.initAmmo(stage.initialAmmo.mags, stage.initialAmmo.rounds);
  hud.toast(stage.briefingHtml(enemyCount), 12000);
  return stage;
}

// クエリパラメータ等、外部由来の未検証文字列を StageId に絞り込む型ガード。
export function isStageId(value: string | null): value is StageId {
  return STAGE_CLASSES.some((c) => c.id === value);
}
