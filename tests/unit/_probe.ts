import { atmosphericDensity, airspeed, dragAccel } from '../../src/physics/atmosphere';
import { v3, len, add, scale } from '../../src/physics/vec3';
import { MU_EARTH, R_EARTH } from '../../src/physics/solar-system';
import * as C from '../../src/game/const';
export function register(): void {}

function run(bcInv: number, label: string): void {
  const alt0 = 420e3;
  let r = v3(R_EARTH + alt0, 0, 0);
  let v = v3(0, 0, -Math.sqrt(MU_EARTH / (R_EARTH + alt0)));
  let t = 0; const dt = 1;
  let temp = C.HULL_START_TEMP; let peakT = temp; let peakQ = 0; let peakQdot = 0;
  let tReentry = -1, tHot = -1, tBreak = -1;
  const heatCap = 1000 * 100;
  while (t < 3600 * 24 * 400) {
    const rr = len(r);
    const g = scale(r, -MU_EARTH / (rr * rr * rr));
    const a = add(g, dragAccel(r, v, bcInv));
    v = add(v, scale(a, dt)); r = add(r, scale(v, dt)); t += dt;
    const alt = len(r) - R_EARTH;
    if (alt < 200e3) {
      const rho = atmosphericDensity(alt);
      const s = len(airspeed(r, v));
      const q = 0.5 * rho * s * s;
      const qdot = C.SG_CONST * Math.sqrt(rho / C.NOSE_RADIUS) * s * s * s;
      const cool = C.HULL_EMISS * C.STEFAN_BOLTZMANN * C.RAD_AREA * (Math.pow(C.ENV_TEMP, 4) - Math.pow(temp, 4));
      temp = Math.max(C.HULL_TEMP_FLOOR, temp + ((qdot * C.HEAT_ABSORB_AREA + cool) / heatCap) * dt);
      peakT = Math.max(peakT, temp); peakQ = Math.max(peakQ, q); peakQdot = Math.max(peakQdot, qdot);
      if (tHot < 0 && temp > C.MAX_HULL_TEMP) tHot = t;
      if (tBreak < 0 && q > C.MAX_DYN_PRESSURE) tBreak = t;
    }
    if (alt < 80e3) { tReentry = t; break; }
  }
  const d = (x: number) => x < 0 ? 'なし' : `${(x / 86400).toFixed(2)}日`;
  console.log(`${label}: bcInv=${bcInv.toExponential(3)} 80km到達=${d(tReentry)} 熱限界=${d(tHot)} 動圧限界=${d(tBreak)} peakT=${peakT.toFixed(0)}K peakQ=${(peakQ/1e3).toFixed(1)}kPa peakQdot=${(peakQdot/1e3).toFixed(0)}kW/m2`);
}
run(3.3e-3, '従来  ');
run(0.03354905911490471, '新(機首前)');
run(0.041958044757520324, '新(平均)  ');
run(0.022985336470399208, '新(横向き)');
