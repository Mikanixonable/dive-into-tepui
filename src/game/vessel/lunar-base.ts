import { habitatBalance, type HabitatBalance } from './habitat';
import { heightAt, normalAt, surfacePointAt } from '../../physics/terrain/height-field';
import type { Vec3 } from '../../physics/vec3';

export interface LunarSite { readonly bodyId: 'moon'; readonly latRad: number; readonly lonRad: number; readonly altitude: number; readonly shadow: boolean; readonly ridgeSunlight: boolean; readonly flatness: number; }
export interface LunarBaseAssessment { readonly site: LunarSite; readonly habitat: HabitatBalance; readonly canOperate: boolean; readonly reasons: readonly string[]; }

export function assessLunarSite(latRad: number, lonRad: number): LunarSite {
  const polar = latRad < -1.25;
  const shadow = polar && heightAt('moon', latRad, lonRad) < -500;
  const ridgeSunlight = polar && heightAt('moon', latRad, lonRad) > 400;
  const slope = Math.acos(Math.max(-1, Math.min(1, (normalAt('moon', latRad, lonRad).y))));
  return { bodyId: 'moon', latRad, lonRad, altitude: heightAt('moon', latRad, lonRad), shadow, ridgeSunlight, flatness: Math.max(0, 1 - slope / (Math.PI / 2)) };
}

export function assessLunarBase(site: LunarSite, crew: number, wasteHeatW: number, radiatorArea: number): LunarBaseAssessment {
  const habitat = habitatBalance({ crew, closedLoopRate: 0.5, cultivationArea: 0, wasteHeatW, radiatorArea, backgroundTemperatureK: site.shadow ? 40 : 250 });
  const reasons: string[] = [];
  if (!site.shadow) reasons.push('not-permanently-shadowed');
  if (site.flatness < 0.7) reasons.push('terrain-too-steep');
  if (habitat.radiatorMargin < 0) reasons.push('insufficient-radiator');
  return { site, habitat, canOperate: reasons.length === 0, reasons };
}

export function baseSitePoint(site: LunarSite): Vec3 { return surfacePointAt('moon', site.latRad, site.lonRad); }
