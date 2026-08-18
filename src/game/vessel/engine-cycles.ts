export type AdvancedEngineCycle = 'nuclear-thermal' | 'hall-electric' | 'ion-electric' | 'magnetic-plasma' | 'fusion';
export interface AdvancedCycleSpec { readonly cycle: AdvancedEngineCycle; readonly specificImpulse: number; readonly thrustClass: 'high' | 'low'; readonly propellant: string; readonly requires: readonly string[]; }
export const ADVANCED_ENGINE_CYCLES: Readonly<Record<AdvancedEngineCycle, AdvancedCycleSpec>> = {
  'nuclear-thermal': { cycle: 'nuclear-thermal', specificImpulse: 900, thrustClass: 'high', propellant: 'liquid-hydrogen', requires: ['uranium'] },
  'hall-electric': { cycle: 'hall-electric', specificImpulse: 1600, thrustClass: 'low', propellant: 'xenon', requires: ['rare-earth'] },
  'ion-electric': { cycle: 'ion-electric', specificImpulse: 3500, thrustClass: 'low', propellant: 'xenon', requires: ['rare-earth'] },
  'magnetic-plasma': { cycle: 'magnetic-plasma', specificImpulse: 5000, thrustClass: 'low', propellant: 'argon', requires: ['rare-earth'] },
  fusion: { cycle: 'fusion', specificImpulse: 10000, thrustClass: 'low', propellant: 'deuterium/helium-3', requires: ['deuterium', 'helium-3'] },
};
