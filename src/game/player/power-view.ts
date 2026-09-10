import type * as THREE from 'three/webgpu';
import type { SolarSide } from './power';

// 太陽電池パネルの蛇腹を機体モデルから引き当て、展開角へ同期する。
export class PowerView {
  private readonly folds: Record<SolarSide, THREE.Object3D[]>;

  // root は自機の表示ツリーの根。蛇腹の Group が揃っていなければ例外を投げる。
  public constructor(root: THREE.Object3D) {
    // 片側ぶんの折り目 Group を名前で引く。
    const collect = (side: SolarSide): THREE.Object3D[] => {
      const namePrefix = `solar${side === 'up' ? 'Up' : 'Down'}Fold`;
      const found = Array.from({ length: 6 }, (_, index) => root.getObjectByName(`${namePrefix}${index}`));
      if (found.some((fold) => !fold)) throw new Error('solar fold objects not found in ship model');
      return found as THREE.Object3D[];
    };
    this.folds = { up: collect('up'), down: collect('down') };
  }

  // deployOf は片側の展開量(0 で収納、1 で全開)。折り目は交互に逆へ折れる。
  public sync(deployOf: (side: SolarSide) => number): void {
    for (const side of ['up', 'down'] as const) {
      const psi = Math.PI / 2 * (1 - deployOf(side));
      const even = (side === 'up' ? 1 : -1) * psi;
      const odd = -even;
      for (let index = 0; index < this.folds[side].length; index++) {
        this.folds[side][index]!.rotation.z = index === 0 ? even : (index % 2 === 1 ? odd - even : even - odd);
      }
    }
  }
}
