import * as THREE from 'three/webgpu';
import { buildAmmoPickup, buildRcsFuelPickup } from '../../../render/ships';
import { DynamicView } from '../dynamic-view';

export class AmmoPickupView extends DynamicView {
  public constructor(scene: THREE.Scene) {
    super(buildAmmoPickup(), scene);
  }
}

export class RcsFuelPickupView extends DynamicView {
  public constructor(scene: THREE.Scene) {
    super(buildRcsFuelPickup(), scene);
  }
}
