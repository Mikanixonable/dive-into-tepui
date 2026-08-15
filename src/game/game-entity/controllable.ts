// PlayerThrottle が操作対象に要求するプロパティの最小インターフェース。
// Ship は既にこれらを全て持つので自動的に満たし、Base は固定値で実装する。
export interface Controllable {
  readonly mass: number;
  readonly totalThrust: number;
  readonly totalTorque: number;
  readonly totalFuelConsumptionRate: number;
  consumeFuel(amount: number): number;
}
