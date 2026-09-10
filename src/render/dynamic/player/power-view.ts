import type * as THREE from 'three/webgpu';

const SOLAR_FOLD_COUNT = 6; // 蛇腹の折り数(1枚あたり)

// 上下2枚の太陽電池パネルの展開量(0 で収納、1 で全開)。
export interface SolarDeploy {
  readonly up: number;
  readonly down: number;
}

// 片側ぶんの折り目 Group を機体モデルから名前で引く。揃っていなければ例外を投げる。
function collectFolds(root: THREE.Object3D, namePrefix: string): readonly THREE.Object3D[] {
  const found = Array.from(
    { length: SOLAR_FOLD_COUNT },
    (_, index) => root.getObjectByName(`${namePrefix}${index}`),
  );
  if (found.some((fold) => !fold)) throw new Error('solar fold objects not found in ship model');
  return found as THREE.Object3D[];
}

// 片側の蛇腹を展開量へ倒す。sign は展開方向の符号、折り目は交互に逆へ折れる。
function tiltFolds(folds: readonly THREE.Object3D[], deploy: number, sign: number): void {
  const psi = Math.PI / 2 * (1 - deploy);
  const even = sign * psi;
  const odd = -even;
  for (let index = 0; index < folds.length; index++) {
    folds[index]!.rotation.z = index === 0 ? even : (index % 2 === 1 ? odd - even : even - odd);
  }
}

// 太陽電池パネルの蛇腹を機体モデルから引き当て、展開角へ同期する。
export class PowerView {
  private readonly up: readonly THREE.Object3D[];
  private readonly down: readonly THREE.Object3D[];

  // root は自機の表示ツリーの根。
  public constructor(root: THREE.Object3D) {
    this.up = collectFolds(root, 'solarUpFold');
    this.down = collectFolds(root, 'solarDownFold');
  }

  // 上下それぞれの展開量へ蛇腹を倒す。
  public sync(deploy: SolarDeploy): void {
    tiltFolds(this.up, deploy.up, 1);
    tiltFolds(this.down, deploy.down, -1);
  }
}
