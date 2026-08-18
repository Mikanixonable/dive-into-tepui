import { dot, norm, scale, sub, type Vec3 } from './vec3';

export interface LandingLeg { readonly id: string; readonly foot: Vec3; readonly stroke: number; readonly safeVerticalSpeed: number; readonly safeHorizontalSpeed: number; readonly maxTiltRad: number; readonly retractable: boolean; }
export interface LandingContact { readonly legId: string; readonly penetration: number; readonly normal: Vec3; readonly verticalSpeed: number; readonly horizontalSpeed: number; }
export interface LandingEvaluation { readonly landed: boolean; readonly damage: number; readonly failures: readonly string[]; }

export function evaluateLanding(legs: readonly LandingLeg[], contacts: readonly LandingContact[], bodyUp: Vec3, bodyVelocity: Vec3, angularSpeed: number, minLegs = 3): LandingEvaluation {
  void bodyVelocity;
  const failures: string[] = [];
  if (legs.length < minLegs) failures.push('too-few-legs');
  if (contacts.length < minLegs) failures.push('too-few-contacts');
  const normal = norm(bodyUp);
  for (const contact of contacts) {
    if (contact.verticalSpeed > (legs.find((leg) => leg.id === contact.legId)?.safeVerticalSpeed ?? 0)) failures.push(`${contact.legId}:vertical-speed`);
    if (contact.horizontalSpeed > (legs.find((leg) => leg.id === contact.legId)?.safeHorizontalSpeed ?? 0)) failures.push(`${contact.legId}:horizontal-speed`);
  }
  if (contacts.some((contact) => Math.acos(Math.max(-1, Math.min(1, dot(normal, norm(contact.normal))))) > (legs.find((leg) => leg.id === contact.legId)?.maxTiltRad ?? 0))) failures.push('tilt');
  if (angularSpeed > 0.2) failures.push('angular-speed');
  const damage = failures.length === 0 ? 0 : failures.length + contacts.reduce((sum, contact) => sum + Math.max(0, contact.penetration), 0);
  return { landed: failures.length === 0, damage, failures };
}

export interface LandingState { readonly landed: boolean; readonly armed: boolean; readonly bodyId: string | null; readonly fixedPosition: Vec3 | null; }
export function updateLandingState(state: LandingState, landedNow: boolean, thrustN: number, weightN: number): LandingState {
  if (state.landed && thrustN > weightN * 1.05) return { ...state, landed: false, armed: false, fixedPosition: null };
  if (!state.landed && state.armed && landedNow) return { ...state, landed: true, armed: false };
  return state;
}
export function landingReaction(normal: Vec3, penetration: number, stiffness: number): Vec3 { return scale(norm(normal), Math.max(0, penetration) * Math.max(0, stiffness)); }
export function tangentialVelocity(velocity: Vec3, normal: Vec3): Vec3 { const n = norm(normal); return sub(velocity, scale(n, dot(velocity, n))); }
