// 共通の表示入力へ、モジュール船の船体・推進・武装の項目を足した表示入力を組み立てる。
import type { DynamicRenderSource } from '../../render/dynamic/dynamic-view';
import type { ModularShipRenderSource } from '../../render/dynamic/ship/modular-ship-dynamic-view';
import type { FireControl } from '../player/fire-control';
import type { Throttle } from '../player/throttle';
import type { ModularShipMotion } from './modular-ship-motion';
import type { ShipAssembly } from './ship-assembly';
import type { ShipCapabilities } from './ship-capabilities';
import { shipRenderAssembly } from './ship-render-adapter';

// 表示入力の組み立てが読む、艦の面。
interface ModularShipRenderSourcePort {
  readonly motion: ModularShipMotion;
  readonly assembly: ShipAssembly;
  readonly capabilities: ShipCapabilities;
  readonly throttle: Throttle;
  readonly fire: FireControl;
}

// 船体 View が読む値を、共通の表示入力へ足す。可動部と噴射は Motion の現在値、
// マーカーの弾数と初速は装備の現在値から、このフレームぶんだけを組む。
export function modularShipRenderSource(
  ship: ModularShipRenderSourcePort, base: DynamicRenderSource, active: boolean,
): ModularShipRenderSource {
  const motion = ship.motion;
  const { belt } = motion;
  // 動圧と対気速度は同じ空力状態から、このフレームの表示入力へ渡す。
  return {
    ...base,
    assembly: shipRenderAssembly(ship.assembly),
    centerOffset: motion.centerOffset,
    state: motion.state,
    active,
    mainThrustAcceleration: ship.throttle.thrust,
    maximumAcceleration: motion.mass > 0 ? ship.capabilities.totalThrust / motion.mass : 0,
    torque: motion.torque,
    dynamicPressure: motion.aero.qdyn,
    ambientDensity: motion.aero.density,
    airspeed: motion.aero.airspeed,
    belt: { anchor: belt.anchor, positions: belt.positions, twists: belt.twists },
    coolingDumpRunning: motion.coolingDump.running,
    magsLeft: ship.fire.beltGun?.mags ?? 0,
    gunFireRate: ship.fire.isFiring ? ship.capabilities.totalFireRate : 0,
    recentShotRecords: ship.fire.recentShotRecords,
  };
}
