import type * as THREE from 'three/webgpu';
import { RADIATOR_FOLD_COUNT, SOLAR_FOLD_COUNT } from '../../../physics/player-shape';

// 上下2枚の太陽電池パネルの展開量(0 で収納、1 で全開)。
export interface SolarDeploy {
  readonly up: number;
  readonly down: number;
}

// 放熱板1枚ぶんの表示値。
export interface RadiatorPanelDisplay {
  readonly wear: number; // 損耗率(0 で無傷、1 で全損)
  readonly even: number; // 偶数番の折り目に与える展開角 [rad]
  readonly odd: number; // 奇数番の折り目に与える展開角 [rad]
}

// 上下2枚の放熱板の表示値。
export interface RadiatorDisplay {
  readonly up: RadiatorPanelDisplay;
  readonly down: RadiatorPanelDisplay;
}

// 1枚ぶんの折り目 Group を機体モデルから名前で引く。揃っていなければ例外を投げる。
function collectFolds(root: THREE.Object3D, namePrefix: string, count: number): readonly THREE.Object3D[] {
  const found = Array.from({ length: count }, (_, index) => root.getObjectByName(`${namePrefix}${index}`));
  if (found.some((fold) => !fold)) throw new Error(`${namePrefix} objects not found in ship model`);
  return found as THREE.Object3D[];
}

// 1枚の蛇腹を、偶数番・奇数番の折り目角 [rad] へ axis 回りに倒す。折り目は交互に逆へ折れる。
function tiltFolds(folds: readonly THREE.Object3D[], axis: 'y' | 'z', even: number, odd: number): void {
  for (let index = 0; index < folds.length; index++) {
    folds[index]!.rotation[axis] = index === 0 ? even : (index % 2 === 1 ? odd - even : even - odd);
  }
}

// 太陽電池パネル1枚を展開量へ倒す。sign は展開方向の符号。
function syncSolarPanel(folds: readonly THREE.Object3D[], deploy: number, sign: number): void {
  const even = sign * (Math.PI / 2) * (1 - deploy);
  tiltFolds(folds, 'z', even, -even);
}

// 放熱板1枚を展開角へ倒し、全損していれば隠す。
function syncRadiatorPanel(folds: readonly THREE.Object3D[], panel: RadiatorPanelDisplay): void {
  tiltFolds(folds, 'y', panel.even, panel.odd);
  const intact = panel.wear < 1;
  for (const fold of folds) fold.visible = intact;
}

// 自機の蛇腹パネル(上下の太陽電池パネルと放熱板)を機体モデルから引き当て、展開角と全損状態へ同期する。
export class FoldingPanelsView {
  private readonly solarUp: readonly THREE.Object3D[];
  private readonly solarDown: readonly THREE.Object3D[];
  private readonly radiatorUp: readonly THREE.Object3D[];
  private readonly radiatorDown: readonly THREE.Object3D[];

  // root は自機の表示ツリーの根。
  public constructor(root: THREE.Object3D) {
    this.solarUp = collectFolds(root, 'solarUpFold', SOLAR_FOLD_COUNT);
    this.solarDown = collectFolds(root, 'solarDownFold', SOLAR_FOLD_COUNT);
    this.radiatorUp = collectFolds(root, 'radiatorUpFold', RADIATOR_FOLD_COUNT);
    this.radiatorDown = collectFolds(root, 'radiatorDownFold', RADIATOR_FOLD_COUNT);
  }

  // 太陽電池パネルを展開量へ、放熱板を展開角と損耗へ合わせる。
  public sync(solar: SolarDeploy, radiator: RadiatorDisplay): void {
    syncSolarPanel(this.solarUp, solar.up, 1);
    syncSolarPanel(this.solarDown, solar.down, -1);
    syncRadiatorPanel(this.radiatorUp, radiator.up);
    syncRadiatorPanel(this.radiatorDown, radiator.down);
  }
}
