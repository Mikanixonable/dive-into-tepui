import type * as THREE from 'three/webgpu';
import type { RadiatorSide } from './radiator';

// 放熱板の蛇腹を機体モデルから引き当て、展開角と全損状態へ同期する。
export class RadiatorView {
  private readonly folds: Record<RadiatorSide, THREE.Object3D[]>;

  // root は自機の表示ツリーの根。蛇腹の Group が揃っていなければ例外を投げる。
  public constructor(root: THREE.Object3D) {
    // 片側ぶんの折り目 Group を名前で引く。
    const collect = (side: RadiatorSide): THREE.Object3D[] => {
      const namePrefix = `radiator${side === 'up' ? 'Up' : 'Down'}Fold`;
      const found = Array.from({ length: 6 }, (_, index) => root.getObjectByName(`${namePrefix}${index}`));
      if (found.some((fold) => !fold)) throw new Error('radiator fold objects not found in ship model');
      return found as THREE.Object3D[];
    };
    this.folds = { up: collect('up'), down: collect('down') };
  }

  // wearOf は片側の摩耗(1 で全損、その側の蛇腹を隠す)、tiltOf は偶数番・奇数番の折り目に
  // 与える展開角 [rad]。折り目は交互に逆へ折れる。
  public sync(
    wearOf: (side: RadiatorSide) => number,
    tiltOf: (side: RadiatorSide) => { readonly even: number; readonly odd: number },
  ): void {
    for (const side of ['up', 'down'] as const) {
      const { even, odd } = tiltOf(side);
      const broken = wearOf(side) >= 1;
      for (let index = 0; index < this.folds[side].length; index++) {
        const fold = this.folds[side][index]!;
        fold.rotation.y = index === 0 ? even : (index % 2 === 1 ? odd - even : even - odd);
        fold.visible = !broken;
      }
    }
  }
}
