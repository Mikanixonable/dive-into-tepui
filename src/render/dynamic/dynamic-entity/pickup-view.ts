import * as THREE from 'three/webgpu';
import { memoParseIndependent } from '../baked-model';
import { DynamicView } from '../dynamic-view';
import ammoPickupData from '../../../assets/models/ammo.json';
import rcsFuelPickupData from '../../../assets/models/rcsFuel.json';

const parseAmmoPickup = memoParseIndependent<THREE.Group>(ammoPickupData);
const parseRcsFuelPickup = memoParseIndependent<THREE.Group>(rcsFuelPickupData);

// 軌道上の弾薬補給物(マガジン数個を束ねてビーコンを付けた漂流物)。
export class AmmoPickupView extends DynamicView {
  // 焼いたモデルを複製して scene へ登録する。
  public constructor(scene: THREE.Scene) {
    super(parseAmmoPickup(), scene);
  }
}

// 軌道上の RCS 燃料補給物。
export class RcsFuelPickupView extends DynamicView {
  // 焼いたモデルを複製して scene へ登録する。
  public constructor(scene: THREE.Scene) {
    super(parseRcsFuelPickup(), scene);
  }
}
