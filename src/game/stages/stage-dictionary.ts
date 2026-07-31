// ステージ一覧の定義を責務とする。各ステージの振る舞い(init/update/checkWin/onWin)
// は stage.ts の Stage を継承した Stage00/Stage0/Stage1/Stage2(このフォルダ内の
// 同名ファイル)が持つ — ここではコンストラクタの列挙と ID 引きのみ行う。
//
// id は各クラスの static readonly id で持たせているので、ID 検索はインスタンス化せずに
// 行える。実際のプレイに使うインスタンスは initStage() が呼ばれるたびに新規 `new` する
// ので、同じインスタンスに setup()/init() を 2 回以上呼んで使い回すことはない。
import * as THREE from 'three/webgpu';
import { Stage, StageId } from './stage';
import type { Player } from '../player/player';
import type { EntityManager } from '../orbit-entity/entity-manager';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import type { UnlockManager } from '../unlock-manager';
import type { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import { Stage00 } from './stage00';
import { Stage0 } from './stage0';
import { Stage1 } from './stage1';
import { Stage2 } from './stage2';

export const DEFAULT_STAGE_ID: StageId = '1';

interface StageClass {
  readonly id: StageId;
  new (): Stage;
}

const STAGE_CLASSES: readonly StageClass[] = [Stage00, Stage0, Stage1, Stage2];

// 選択画面のラベル・解放判定など、setup()/init() を呼ばない読み取り専用の一覧。
export const STAGE_DEFINITIONS: readonly Stage[] = STAGE_CLASSES.map((StageClass) => new StageClass());

// id からステージを新規生成し、setup/init まで済ませて返す(Game がステージ開始時に
// 一度だけ呼ぶ)。
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
): Stage {
  const StageClass = STAGE_CLASSES.find((c) => c.id === stageId) ?? STAGE_CLASSES.find((c) => c.id === DEFAULT_STAGE_ID)!;
  const stage = new StageClass();
  stage.setup(hud, sfx, scene, entities, unlockManager, fx, markerManager);
  const enemyCount = stage.init(player, entities);
  player.initAmmo(stage.initialAmmo.mags, stage.initialAmmo.rounds);
  hud.toast(stage.briefingHtml(enemyCount), 12000);
  return stage;
}

// クエリパラメータ等、外部由来の未検証文字列を StageId に絞り込む型ガード。
export function isStageId(value: string | null): value is StageId {
  return STAGE_CLASSES.some((c) => c.id === value);
}
