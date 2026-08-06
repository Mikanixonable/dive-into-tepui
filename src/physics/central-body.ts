import { Ephemeris } from './ephemeris';
import { OrbitState, orbitState, MU_EARTH } from './orbital';
import { add, sub } from './vec3';

/** 天体中心軌道計算の基準天体。既定値は従来互換の地球。 */
export type CentralBodyId = 'earth' | 'moon';

export interface CentralBodyDefinition {
  id: CentralBodyId;
  label: string;
  mu: number;
  radius: number;
}

export const CENTRAL_BODIES: Record<CentralBodyId, CentralBodyDefinition> = {
  earth: { id: 'earth', label: 'EARTH', mu: MU_EARTH, radius: 6_378_137 },
  moon: { id: 'moon', label: 'MOON', mu: 4.9048695e12, radius: 1_737_400 },
};

export function centralBodyDefinition(id: CentralBodyId): CentralBodyDefinition {
  return CENTRAL_BODIES[id];
}

/** 地球ECI状態を選択した天体中心の慣性相対状態へ変換する。 */
export function toCentralBodyState(state: OrbitState, body: CentralBodyId, ephemeris: Ephemeris): OrbitState {
  if (body === 'earth') return state;
  return orbitState(state.t, sub(state.r, ephemeris.moonPosAt(state.t)), sub(state.v, ephemeris.moonVelAt(state.t)));
}

/** 天体中心相対状態をゲームの地球ECI状態へ戻す。 */
export function fromCentralBodyState(state: OrbitState, body: CentralBodyId, ephemeris: Ephemeris): OrbitState {
  if (body === 'earth') return state;
  return orbitState(state.t, add(state.r, ephemeris.moonPosAt(state.t)), add(state.v, ephemeris.moonVelAt(state.t)));
}
