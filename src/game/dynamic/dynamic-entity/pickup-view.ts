import * as THREE from 'three/webgpu';
import { buildAmmoPickup, buildRcsFuelPickup } from '../../../render/ships';
import { DynamicView } from '../dynamic-view';
import type { PickupKind } from './pickup-motion';

export class PickupView extends DynamicView {
  constructor(kind: PickupKind, scene: THREE.Scene) {
    super(kind === 'ammo' ? buildAmmoPickup() : buildRcsFuelPickup(), scene);
  }
}
