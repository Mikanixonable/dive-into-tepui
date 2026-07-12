import { SimState } from './bodies';
import { stepRK4 } from './integrator';

interface StepRequest {
  type: 'step';
  state: SimState;
  dt: number;
  substeps: number;
}

self.onmessage = (event: MessageEvent<StepRequest>) => {
  const { state, dt, substeps } = event.data;
  const subDt = dt / substeps;

  let bodies = state.bodies;
  for (let i = 0; i < substeps; i++) {
    bodies = stepRK4(bodies, subDt);
  }

  const nextState: SimState = { time: state.time + dt, bodies };
  (self as unknown as Worker).postMessage(nextState);
};
