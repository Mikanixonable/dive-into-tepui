import {
  LOCAL_FORWARD, Q_IDENTITY, qFromAxisAngle, qInvert, qMul, qNormalize, qRotate, type Quat,
} from '../../math/quat';
import { v3, type Vec3 } from '../../math/vec3';
import type { ShipModuleDefinition } from './ship-module-definition';
import type { ModuleTransform, SideSlot } from './ship-assembly-types';
import type { ShipModuleInstance } from './ship-module-instance';

// 接続軸まわりの 90° 単位のロール。
export type ModuleRoll = 0 | 1 | 2 | 3;

// モジュールの軸方向の端。front は +Z 端、back は −Z 端。
export type AxialFace = 'front' | 'back';

// モジュールの向き。roll は接続軸まわりの 90° 単位の回し、face は親へ向ける端。
export interface ModuleOrientation {
  readonly roll: ModuleRoll;
  readonly face: AxialFace;
}

// 軸方向接続の取り付け位置と向き。parentFace は親のどちらの端へ付いたか。
export interface AxialPlacement {
  readonly parentFace: AxialFace;
  readonly orientation: ModuleOrientation;
}

const Y_FLIP: Quat = { x: 0, y: 1, z: 0, w: 0 };

// Z 軸まわり roll·90° の回転。
function rollRotation(roll: ModuleRoll): Quat {
  return roll === 0 ? Q_IDENTITY : qFromAxisAngle(LOCAL_FORWARD, roll * Math.PI / 2);
}

// 軸方向の取り付け変換。子は親の parentFace 側へ、自身の orientation.face の端を向けて付く。
// 子の取り付け面が親の面と正対する(a = −s)なら無回転、背中合わせなら Y 軸まわりに 180° 反転する。
export function axialMountTransform(
  parent: ShipModuleDefinition, child: ShipModuleDefinition,
  parentFace: AxialFace, orientation: ModuleOrientation,
): ModuleTransform {
  const s = parentFace === 'front' ? 1 : -1;
  const a = orientation.face === 'front' ? 1 : -1;
  const flip = a === -s ? Q_IDENTITY : Y_FLIP;
  return {
    position: v3(0, 0, s * (parent.length / 2 + child.length / 2)),
    rotation: qMul(flip, rollRotation(orientation.roll)),
  };
}

// 剛体変換の逆変換。
export function inverseTransform(transform: ModuleTransform): ModuleTransform {
  const rotation = qInvert(transform.rotation);
  return {
    position: qRotate(rotation, v3(
      -transform.position.x, -transform.position.y, -transform.position.z,
    )),
    rotation,
  };
}

function sameRotation(a: Quat, b: Quat): boolean {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  return Math.abs(Math.abs(dot) - 1) < 1e-9;
}

// 軸方向の取り付け変換から向きを読み戻す。許容する回転は Z 軸まわり 90° 単位と
// その Y 軸 180° との合成の 8 通り。位置が x = y = 0 でないか、どれにも当たらなければ null。
export function axialPlacementFromTransform(transform: ModuleTransform): AxialPlacement | null {
  const p = transform.position;
  if (Math.abs(p.x) > 1e-9 || Math.abs(p.y) > 1e-9 || Math.abs(p.z) <= 1e-9) return null;
  const parentFace: AxialFace = p.z > 0 ? 'front' : 'back';
  for (const flipped of [false, true]) {
    for (const roll of [0, 1, 2, 3] as const) {
      const expected = qMul(flipped ? Y_FLIP : Q_IDENTITY, rollRotation(roll));
      if (sameRotation(transform.rotation, expected)) {
        const face: AxialFace = flipped ? parentFace : (parentFace === 'front' ? 'back' : 'front');
        return { parentFace, orientation: { roll, face } };
      }
    }
  }
  return null;
}

// 側面の取り付け変換が標準の変換と Z 軸まわりのどのロールの合成かを返す。どれでもなければ null。
export function sideRollFromTransform(
  parent: ShipModuleDefinition, child: ShipModuleDefinition,
  slot: SideSlot, transform: ModuleTransform,
): ModuleRoll | null {
  for (const roll of [0, 1, 2, 3] as const) {
    if (sameTransform(transform, sideMountTransform(parent, child, slot, roll))) return roll;
  }
  return null;
}

export function copyTransform(transform: ModuleTransform): ModuleTransform {
  return {
    position: v3(transform.position.x, transform.position.y, transform.position.z),
    rotation: { ...transform.rotation },
  };
}

export function normalizedTransform(transform: ModuleTransform): ModuleTransform {
  if (!finiteVector(transform.position) || !finiteQuaternion(transform.rotation)) {
    throw new Error('module transform must be finite');
  }
  const length = Math.hypot(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w);
  if (!(length > 1e-12)) throw new Error('module transform rotation must be nonzero');
  return {
    position: v3(transform.position.x, transform.position.y, transform.position.z),
    rotation: qNormalize(transform.rotation),
  };
}

export function finiteVector(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

export function finiteQuaternion(value: Quat): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y)
    && Number.isFinite(value.z) && Number.isFinite(value.w);
}

export function isIdentityRotation(value: Quat): boolean {
  return value.x === 0 && value.y === 0 && value.z === 0 && value.w === 1;
}

export function sideSlotDirection(slot: SideSlot): Vec3 {
  switch (slot) {
    case 'side:+x': return v3(1, 0, 0);
    case 'side:-x': return v3(-1, 0, 0);
    case 'side:+y': return v3(0, 1, 0);
    case 'side:-y': return v3(0, -1, 0);
  }
}

export function sideSlotRotation(slot: SideSlot): Quat {
  const INV_SQRT2 = Math.SQRT1_2;
  switch (slot) {
    case 'side:+x': return { x: 0, y: INV_SQRT2, z: 0, w: INV_SQRT2 };
    case 'side:-x': return { x: 0, y: -INV_SQRT2, z: 0, w: INV_SQRT2 };
    case 'side:+y': return { x: -0.5, y: 0.5, z: 0.5, w: 0.5 };
    case 'side:-y': return { x: 0.5, y: 0.5, z: -0.5, w: 0.5 };
  }
}

// 円筒タンクは直径の半分、前端径が後端の半分のコックピットは中央断面半径を側面取付面とする。
export function sideMountRadius(parent: ShipModuleDefinition): number {
  return parent.kind === 'cockpit'
    ? parent.diameter * 3 / 8
    : parent.diameter / 2;
}

// roll は接続軸(子の local +Z)まわりの 90° 単位の回しで、スロットの向きを決める変換の前に掛かる。
export function sideMountTransform(
  parent: ShipModuleDefinition, child: ShipModuleDefinition, slot: SideSlot, roll: ModuleRoll = 0,
): ModuleTransform {
  const direction = sideSlotDirection(slot);
  // 翼面を持つモジュールの面法線(local +Y)を、スロットの正負に関わらず同じ向きへ揃える。
  // ±X スロットではロールなしで両側とも面が +Y を向く。±Y スロットでは面が ±X に割れるため、
  // -y 側では外向き軸まわりに180度ロールを足して +y 側と向きを揃える。
  const wingRoll = (child.kind === 'solar_panel' || child.kind === 'radiator')
    && slot === 'side:-y'
    ? qFromAxisAngle(v3(0, 0, 1), Math.PI) : Q_IDENTITY;
  return {
    position: v3(
      direction.x * (sideMountRadius(parent) + child.length / 2),
      direction.y * (sideMountRadius(parent) + child.length / 2),
      0,
    ),
    rotation: qMul(qMul(sideSlotRotation(slot), wingRoll), rollRotation(roll)),
  };
}

export function sideSlotFromTransform(transform: ModuleTransform): SideSlot | null {
  const p = transform.position;
  const values: readonly [SideSlot, number][] = [
    ['side:+x', p.x], ['side:-x', -p.x], ['side:+y', p.y], ['side:-y', -p.y],
  ];
  const best = values.reduce((current, candidate) => candidate[1] > current[1] ? candidate : current);
  if (best[1] <= 1e-9 || Math.abs(p.z) > 1e-9) return null;
  return best[0];
}

export function sameTransform(actual: ModuleTransform, expected: ModuleTransform): boolean {
  const p = actual.position;
  const e = expected.position;
  if (Math.hypot(p.x - e.x, p.y - e.y, p.z - e.z) > 1e-9) return false;
  return sameRotation(actual.rotation, expected.rotation);
}

export function isSideParent(kind: ShipModuleInstance['kind']): boolean {
  return kind === 'cockpit' || kind === 'tank';
}

export function isSideChild(kind: ShipModuleInstance['kind']): boolean {
  return kind === 'dock' || kind === 'docking_port' || kind === 'solar_panel' || kind === 'radiator';
}
