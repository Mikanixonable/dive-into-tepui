import type * as THREE from 'three/webgpu';
import type { SolarSide } from './power';

export class PowerView {
  private readonly folds: Record<SolarSide, THREE.Object3D[]>;

  public constructor(root: THREE.Object3D) {
    const collect = (side: SolarSide): THREE.Object3D[] => {
      const namePrefix = `solar${side === 'up' ? 'Up' : 'Down'}Fold`;
      const found = Array.from({ length: 6 }, (_, index) => root.getObjectByName(`${namePrefix}${index}`));
      if (found.some((fold) => !fold)) throw new Error('solar fold objects not found in ship model');
      return found as THREE.Object3D[];
    };
    this.folds = { up: collect('up'), down: collect('down') };
  }

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
