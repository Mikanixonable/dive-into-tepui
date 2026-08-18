export interface CommunicationPanelState { readonly inRange: boolean; readonly nearestRelay: string | null; readonly rangeMargin: number; }
export interface StagePanelState { readonly stages: readonly { id: string; remainingDv: number; next: boolean }[]; }
export interface AblatorPanelState { readonly visible: boolean; readonly remainingMass: number; readonly maxMass: number; }
export interface FlightPanelState { readonly communication: CommunicationPanelState; readonly stages: StagePanelState; readonly ablator: AblatorPanelState; }

export function communicationPanelState(inRange: boolean, nearestRelay: string | null, rangeMargin: number): CommunicationPanelState {
  return { inRange, nearestRelay, rangeMargin };
}
export function stagePanelState(stages: readonly { id: string; remainingDv: number }[], nextId: string | null): StagePanelState {
  return { stages: stages.map((stage) => ({ ...stage, next: stage.id === nextId })) };
}
export function ablatorPanelState(remainingMass: number, maxMass: number, atmosphericOrbit: boolean): AblatorPanelState {
  return { visible: atmosphericOrbit, remainingMass: Math.max(0, remainingMass), maxMass: Math.max(0, maxMass) };
}
