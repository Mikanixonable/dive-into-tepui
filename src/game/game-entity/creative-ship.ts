// クリエイティブモードに配置される宇宙船。AI・戦闘は持たず、Player の移動/計画機構だけを
// 引き継いだ上で、軌道計画への自動追従(followPlan)を CreativeStage.update から駆動される。
import type * as THREE from 'three/webgpu';
import type { OrbitState } from '../../physics/orbital';
import { Player } from '../player/player';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';

export class CreativeShip extends Player {
  // ON の間、CreativeStage.update が毎フレーム自身の plan の先頭ノード時刻を跨いだかを見て、
  // 跨いだ時点で state をそのノードの絶対状態へ瞬間的に置き換える。
  followPlan = false;

  constructor(
    hud: Hud, sfx: Sfx, scene: THREE.Scene, fx: EffectsSystem, markerManager: MarkerManager,
    name: string, initialState: OrbitState,
  ) {
    super(hud, sfx, scene, fx, markerManager, name, initialState);
  }
}
