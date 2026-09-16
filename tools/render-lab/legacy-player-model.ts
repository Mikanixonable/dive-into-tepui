// 旧固定モデルを使う既存の照明・影ケース専用 loader。
// ゲーム本体の船体表示は ModularShipView を使い、この asset へ戻らない。
import type * as THREE from 'three/webgpu';
import playerData from '../../src/assets/models/player.json';
import { memoParseIndependent } from '../../src/render/dynamic/baked-model';

const parsePlayer = memoParseIndependent<THREE.Group>(playerData);

export function buildLegacyPlayerShip(): THREE.Group {
  return parsePlayer();
}
