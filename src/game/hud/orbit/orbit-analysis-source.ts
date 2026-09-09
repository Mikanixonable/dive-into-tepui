import { aliveCombatTarget } from '../../dynamic/dynamic-entity/combat-target';
import type { DisplayWindowManager } from '../../display-window-manager';
import type { CelestialSystem } from '../../celestial/celestial-system';
import type { Controllable } from '../../dynamic/dynamic-entity/controllable';
import type { DynamicEntity } from '../../dynamic/dynamic-entity/dynamic-entity';
import type { DynamicSystem } from '../../dynamic/dynamic-system';
import type { NavTarget } from '../../nav-target';
import type { OrbitReference, OrbitReferenceSelector } from '../../orbit-reference';
import type { ApproachTargetSource } from './orbit-analysis-data';

// 軌道分析ウィンドウとタブへ、reader更新と表示同期に必要な値を渡す境界。
export interface OrbitAnalysisReaderInput {
  readonly entity: DynamicEntity | null;
  readonly targetEntity: DynamicEntity | null;
}

// 軌道分析タブが1回の可否判定・描画で参照する値。
export interface OrbitAnalysisTabInput {
  readonly entity: DynamicEntity;
  readonly reference: OrbitReference;
  readonly target: ApproachTargetSource | null;
  readonly celestialSystem: CelestialSystem;
  readonly displayDurationSec: number;
}

// 軌道分析ウィンドウが1回の表示同期で参照する値。
export type OrbitAnalysisSyncInput =
  | {
      readonly entity: null;
      readonly reference: null;
      readonly target: null;
      readonly celestialSystem: CelestialSystem;
      readonly displayDurationSec: number;
    }
  | (OrbitAnalysisTabInput & { readonly entity: Controllable });

// 軌道分析に必要な現在値と問い合わせ口。
export interface OrbitAnalysisSource {
  readonly activeControllable: Controllable | null;
  readonly navTarget: NavTarget;
  readonly dynamicSystem: DynamicSystem;
  readonly celestialSystem: CelestialSystem;
  readonly orbitReference: OrbitReferenceSelector;
  readonly displayWindowManager: Pick<DisplayWindowManager, 'current'>;
}

// 航法ターゲットを軌道分析のターゲット表現へ解決する。
export function approachTargetOf(source: OrbitAnalysisSource): ApproachTargetSource | null {
  const id = source.navTarget.id;
  if (id === null) return null;
  const body = source.celestialSystem.find(id)?.motion;
  if (body !== undefined) return { kind: 'celestialBody', body };
  const entity = aliveCombatTarget(source.dynamicSystem.all(), id);
  return entity ? { kind: 'entity', entity } : null;
}

// reader更新へ渡す操作対象と戦闘ターゲットを組み立てる。
export function readerInputOf(source: OrbitAnalysisSource): OrbitAnalysisReaderInput {
  const entity = source.activeControllable;
  const target = entity === null ? null : approachTargetOf(source);
  return {
    entity,
    targetEntity: target?.kind === 'entity' ? target.entity : null,
  };
}

// 表示同期へ渡す軌道分析の入力を組み立てる。
export function syncInputOf(source: OrbitAnalysisSource): OrbitAnalysisSyncInput {
  const entity = source.activeControllable;
  if (entity === null) {
    return {
      entity: null,
      reference: null,
      target: null,
      celestialSystem: source.celestialSystem,
      displayDurationSec: source.displayWindowManager.current.duration,
    };
  }

  const target = approachTargetOf(source);
  const reference = source.orbitReference.resolve(
    entity.state.r, source.celestialSystem.celestialMotions, source.navTarget,
    source.dynamicSystem, source.celestialSystem, entity.state.t,
  );
  return {
    entity,
    reference,
    target,
    celestialSystem: source.celestialSystem,
    displayDurationSec: source.displayWindowManager.current.duration,
  };
}
