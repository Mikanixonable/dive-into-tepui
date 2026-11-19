// 提示が読む狭い面（ポート）の集まり。面の型は葉に置けるものだけで組み、
// 受け手が使うメンバだけを持つ。
import type { KeyBinding } from '../input/key-mapping';
import type { Vec3 } from '../math/vec3';
import type { CelestialBody } from '../physics/celestial-body';
import type { KinematicState } from '../physics/kinematic-state';
import type { CelestialBodies } from './celestial/celestial-bodies';
import type { CombatTarget } from './dynamic/dynamic-entity/combat-target';
import type { DynamicEntity } from './dynamic/dynamic-entity/dynamic-entity';
import type { DynamicEntityKind } from './dynamic/dynamic-entity/entity-kind';
import type { BurnManagementViewModel } from './hud/panels/burn-management-panel';
import type { PowerSystem } from './player/power';
import type { RadiatorSystem } from './player/radiator';
import type { ViewMode } from './view/view-mode';
import type { FocusTarget } from './viewer/focus-target';
import type { OrbitReferenceSelection } from './viewer/orbit-reference-selection';

// 提示からキー操作を送る面。送るのはキー割り当てだけ。
export interface PresentationInput {
  /** 割り当てられたキーを押す。 */
  tapKey(key: KeyBinding): void;
}

// 提示する段の読み取り面。識別名・敵数・撃破数と、計画実行と建造の入口。
export interface PresentationStage {
  readonly stageClass: { readonly selectLabel: string };
  readonly enemiesAppeared: number;
  readonly scoreCounter: { readonly kills: number };
  readonly executesPlans: boolean;
  readonly authoring: PresentationStageAuthoring | null;
}

// 時間加速の読み取りと操作の面。倍率・自動ワープの残りと、段の切り替え。
export interface PresentationSimSpeed {
  readonly simSpeed: number;
  estimatedRealSecondsToWarpEnd(simTime: number): number | null;
  remainingSimulationSeconds(simTime: number): number | null;
  setSpeed(speed: number): void;
  shift(step: -1 | 1): void;
  startAutoWarpTo(time: number, simTime: number): boolean;
  cancelAutoWarp(): void;
  toggleAutoWarpToFirstNode(firstNode: KinematicState | null, simTime: number): void;
}

// ビューの選択を切り替える面。指定のビューへの切り替えと戦闘/マップの往復。
export interface PresentationViewSelection {
  select(view: ViewMode): boolean;
  toggle(): void;
}

// 視点の選択を読む面。ビュー・航法ターゲット・軌道基準・戦闘カメラの追従。
export interface PresentationViewer {
  readonly view: PresentationViewSelection;
  readonly navTarget: { readonly id: string | null; readonly name: string | null };
  readonly orbitReference: OrbitReferenceSelection;
  readonly camera: {
    readonly combat: { readonly rotationFollow: { readonly kind: string } | null };
  };
}

// カメラの注視を読む面。現在の注視対象と、マップの注視点の位置。
export interface PresentationCameraSystem {
  readonly activeFocus: FocusTarget;
  readonly mapResolvedFocus: Vec3;
}

// 表示窓の読み取り面。表示時刻・元期・表示期間。
export interface PresentationDisplayWindow {
  readonly simTime: number;
  readonly epochUnixSec: number;
  readonly duration: number;
}

// 航行指令の窓を開く面。対象の id と表示名で開く。
export interface PresentationNavigationCommand {
  open(targetId: string | null, name: string): void;
}

// 物体窓を開く面。敵とターゲットの窓。
export interface PresentationObjectWindows {
  openEnemy(id: string, clientX: number, clientY: number): void;
  openTarget(clientX: number, clientY: number): void;
}

// 搭載部品の読み取り面。識別子・種別・残 HP。
export interface PresentationShipModule {
  readonly id: string;
  readonly kind: string;
  readonly hp: number;
}

// 艦の読み取り面。操縦可否と、搭載部品の一覧。
export interface PresentationShip {
  readonly id: string;
  readonly capabilities: { readonly controllable: boolean; readonly averageMuzzleVelocity: number };
  readonly assembly: {
    readonly modules: readonly PresentationShipModule[];
  };
}

// 艦の運動のうち提示が読む部分。動圧と、展開物の展開状態。
export interface PresentationShipMotion {
  readonly aero: { readonly qdyn: number };
  readonly power: PowerSystem;
  readonly radiator: RadiatorSystem;
}

// 艦の RCS 燃料と燃焼管理の読み取り面。
export interface PresentationShipSystems {
  readonly motion: PresentationShipMotion;
  readonly totalRcsFuel: number;
  readonly totalMaxRcsFuel: number;
  burnManagementViewModel(): BurnManagementViewModel | null;
}

// mapKind が player/base の個体は ModularShip で、艦の面を持つ。player/base を立てるのは
// ModularShip の構築と更新だけなので、種別での判定は instanceof と同じ意味になる。
export function isPresentationShip(
  entity: { readonly mapKind: DynamicEntityKind | null },
): entity is DynamicEntity & PresentationShip & PresentationShipSystems {
  return entity.mapKind === 'player' || entity.mapKind === 'base';
}

// 敵の読み取り面。所属するウェーブの番号。ウェーブに属さない敵は null。
export interface PresentationEnemy {
  readonly waveId: number | null;
}

// mapKind が enemy の個体は Enemy で、戦闘対象の面と敵の面を持つ。enemy を立てるのは
// Enemy の宣言だけなので、種別での判定は instanceof と同じ意味になる。
export function isPresentationEnemy(
  entity: { readonly mapKind: DynamicEntityKind | null },
): entity is CombatTarget & PresentationEnemy {
  return entity.mapKind === 'enemy';
}

// 天体1体の提示用の面。運動と、地表テクスチャの有無。
export interface PresentationCelestialEntity {
  readonly motion: CelestialBody;
  readonly view: { readonly surfaceTextureUrl: string | null };
}

// 天体系の提示用の面。表示名・天体の索引・系の物理を、構築の全体から切り離して読む。
export interface PresentationCelestialSystem extends CelestialBodies {
  find(id: string): PresentationCelestialEntity | null;
  entityOf(id: string): PresentationCelestialEntity;
}

// 動的個体の一覧を読む面。提示が要るのは全個体だけ。
export interface PresentationDynamicSystem {
  all(): readonly DynamicEntity[];
}

// 生存中の標的を読む面。提示が要るのは生存中の対象だけ。
export interface PresentationTargeter {
  readonly aliveTarget: CombatTarget | null;
}

// マップでの物体配置の面。配置窓と複製の開始。
export interface PresentationStageAuthoring {
  openObjectPlacer(focusId?: string | null): void;
  openObjectPlacerForDuplicate(entityKind: DynamicEntityKind, state: KinematicState): void;
}

// 計画の編集面。通過時刻への加速と、その時刻へのノード追加。
export interface PresentationPlanEditor {
  warpTo(t: number): void;
  addNodeAt(t: number): void;
}

// 航法ターゲットの読み取り面。対象の id。
export interface PresentationNavTarget {
  readonly id: string | null;
}

// 航法ターゲットの選択を切り替える面。
export interface PresentationNavTargetCommands {
  toggle(id: string, name: string): void;
}

// 実体ごとの表示設定を読む面。予測線・過去線の有無。
export interface PresentationEntityDisplay {
  showsTrajectoryLine(id: string): boolean;
}

// 実体ごとの表示設定を切り替える面。
export interface PresentationEntityDisplayCommands {
  toggleTrajectoryLine(id: string): void;
}

// マップのカメラの注視を読む面。
export interface PresentationMapCamera {
  readonly map: { readonly focus: FocusTarget };
}

// 現在のビューを読む面。
export interface PresentationView {
  readonly current: ViewMode;
}

// カメラの注視を移す面。
export interface PresentationFocusCameraCommands {
  setFocus(target: FocusTarget): void;
}

// 一時停止メニューの開閉面。
export interface PresentationPauseMenu {
  toggle(force?: boolean): void;
}

// 搭載部品の窓を開く面。艦と部品の指定で開く。
export interface PresentationModuleWindows {
  open(ship: PresentationShip, moduleId: string, clientX: number, clientY: number): void;
  openAtDefault(ship: PresentationShip, moduleId: string): void;
}
