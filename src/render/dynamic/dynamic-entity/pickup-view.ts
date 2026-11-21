// 軌道上の補給物(弾薬・RCS燃料)の見た目。種別ごとに焼いたモデルだけが違う。
import type * as THREE from 'three/webgpu';
import { cloneIndependent, memoParseIndependent } from '../baked-model';
import { DynamicView } from '../dynamic-view';
import { getAmmoPickupTemplate } from '../ammo-models';
import rcsFuelPickupData from '../../../assets/models/rcsFuel.json';

const PARSE = {
  ammo: (): THREE.Group => cloneIndependent(getAmmoPickupTemplate()),
  'rcs-fuel': memoParseIndependent<THREE.Group>(rcsFuelPickupData),
} as const;

export class PickupView extends DynamicView {
  // kind に対応する焼いたモデルを複製して scene へ登録する。
  public constructor(scene: THREE.Scene, kind: keyof typeof PARSE) {
    super(PARSE[kind](), scene);
  }
}
