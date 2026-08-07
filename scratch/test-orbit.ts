import { MU_EARTH, elementsFromState, stateFromElements } from '../src/physics/orbital';

let a = 7000e3;
let e = 0;
let inc = 0;
let raan = 0;
let argp = 0;
let nu = 0;
let mu = MU_EARTH;

let state1 = stateFromElements(0, a, e, inc, raan, argp, nu, mu);
let el1 = elementsFromState(state1.r, state1.v, mu);
console.log("State 1 (t=0, a=7000): a =", el1?.a, "e =", el1?.e);

let state2 = stateFromElements(3600, a, e, inc, raan, argp, nu, mu);
let el2 = elementsFromState(state2.r, state2.v, mu);
console.log("State 2 (t=3600, a=7000): a =", el2?.a, "e =", el2?.e);

a = 8000e3;
let state3 = stateFromElements(3600, a, e, inc, raan, argp, nu, mu);
let el3 = elementsFromState(state3.r, state3.v, mu);
console.log("State 3 (t=3600, a=8000): a =", el3?.a, "e =", el3?.e);
