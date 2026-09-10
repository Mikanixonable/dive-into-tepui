import type * as THREE from 'three/webgpu';

const RADIATOR_FOLD_COUNT = 6; // 蛇腹の折り数(1枚あたり)

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

// 片側ぶんの折り目 Group を機体モデルから名前で引く。揃っていなければ例外を投げる。
function collectFolds(root: THREE.Object3D, namePrefix: string): readonly THREE.Object3D[] {
  const found = Array.from(
    { length: RADIATOR_FOLD_COUNT },
    (_, index) => root.getObjectByName(`${namePrefix}${index}`),
  );
  if (found.some((fold) => !fold)) throw new Error('radiator fold objects not found in ship model');
  return found as THREE.Object3D[];
}

// 片側の蛇腹を展開角へ倒し、全損した側は隠す。折り目は交互に逆へ折れる。
function tiltFolds(folds: readonly THREE.Object3D[], panel: RadiatorPanelDisplay): void {
  const broken = panel.wear >= 1;
  for (let index = 0; index < folds.length; index++) {
    const fold = folds[index]!;
    fold.rotation.y = index === 0
      ? panel.even
      : (index % 2 === 1 ? panel.odd - panel.even : panel.even - panel.odd);
    fold.visible = !broken;
  }
}

// 放熱板の蛇腹を機体モデルから引き当て、展開角と全損状態へ同期する。
export class RadiatorView {
  private readonly up: readonly THREE.Object3D[];
  private readonly down: readonly THREE.Object3D[];

  // root は自機の表示ツリーの根。
  public constructor(root: THREE.Object3D) {
    this.up = collectFolds(root, 'radiatorUpFold');
    this.down = collectFolds(root, 'radiatorDownFold');
  }

  // 上下それぞれの展開角と損耗へ蛇腹を合わせる。
  public sync(radiator: RadiatorDisplay): void {
    tiltFolds(this.up, radiator.up);
    tiltFolds(this.down, radiator.down);
  }
}
