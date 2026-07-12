import * as THREE from 'three/webgpu';
import { createGameScene } from './render/scene';
import { SimState } from './physics/bodies';

// 概算値: 地球-月系の初期状態 (単位: m, m/s)
const EARTH_MASS = 5.972e24;
const MOON_MASS = 7.342e22;
const EARTH_MOON_DISTANCE = 3.844e8;
const MOON_ORBITAL_SPEED = 1022; // 月の平均公転速度

const initialState: SimState = {
  time: 0,
  bodies: [
    {
      name: 'Earth',
      mass: EARTH_MASS,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    },
    {
      name: 'Moon',
      mass: MOON_MASS,
      position: { x: EARTH_MOON_DISTANCE, y: 0, z: 0 },
      velocity: { x: 0, y: MOON_ORBITAL_SPEED, z: 0 },
    },
  ],
};

async function main() {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);

  const { scene, camera, renderer } = await createGameScene(canvas);

  scene.add(new THREE.AmbientLight(0xffffff, 0.2));
  const sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
  sunLight.position.set(1, 0, 0);
  scene.add(sunLight);

  const bodyMeshes = new Map<string, THREE.Mesh>();
  const earthMesh = new THREE.Mesh(
    new THREE.SphereGeometry(6371, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0x2266aa }),
  );
  bodyMeshes.set('Earth', earthMesh);
  scene.add(earthMesh);

  const moonMesh = new THREE.Mesh(
    new THREE.SphereGeometry(1737, 32, 32),
    new THREE.MeshStandardMaterial({ color: 0x999999 }),
  );
  bodyMeshes.set('Moon', moonMesh);
  scene.add(moonMesh);

  const worker = new Worker(new URL('./physics/physics.worker.ts', import.meta.url), {
    type: 'module',
  });

  let state = initialState;
  let stepPending = false;

  worker.onmessage = (event: MessageEvent<SimState>) => {
    state = event.data;
    stepPending = false;
  };

  function requestStep(dt: number) {
    if (stepPending) return;
    stepPending = true;
    worker.postMessage({ type: 'step', state, dt, substeps: 8 });
  }

  function syncMeshes() {
    for (const body of state.bodies) {
      const mesh = bodyMeshes.get(body.name);
      if (mesh) mesh.position.set(body.position.x, body.position.y, body.position.z);
    }
  }

  let lastTime = performance.now();
  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    requestStep(dt);
    syncMeshes();
    renderer.render(scene, camera);
  }
  animate();
}

main();
