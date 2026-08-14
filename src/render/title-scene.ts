// タイトル画面の背景となる 3D 場面。対称性の高い幾何立体(正多面体・トーラス・立方体)を
// 光沢プラスチックの材質で奥行き方向へ散らし、極小速度で漂わせる。
// ゲーム世界とは無関係な表示専用の場面なので、physics/ も game/ も参照しない。
import * as THREE from 'three/webgpu';

// 材質。roughness 0.16–0.28 / metalness 0–0.06 / clearcoat 0.7–1.0 の光沢プラスチック帯。
const BODY_COLORS = [0xf1edf0, 0xa8aec0, 0x48506a, 0xd6d6d0] as const;
const ACCENT_COLOR = 0xff3155;
const NEAR_ACCENT_COLOR = 0xff6b82;
const SECONDARY_ACCENT_COLOR = 0x3478ff;
const BODY_COUNT = 24;
// V6 §5.2 に従い、Accent / Near accent は各1体、Secondaryは1体だけに絞る。
const ACCENT_INDEX = 7;
const NEAR_ACCENT_INDEX = 15;
const SECONDARY_ACCENT_INDEX = 21;

export interface TitleScene {
  // 破棄。アニメーションループとリスナーを止め、GPU 資源を解放する。
  dispose(): void;
}

// canvas へ 3D 場面を構築して回し始める。canvas の CSS 寸法に追従し、
// pointerTarget 上のポインタ移動へカメラがわずかに追随する。
export async function createTitleScene(
  canvas: HTMLCanvasElement,
  pointerTarget: HTMLElement,
): Promise<TitleScene> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  await renderer.init();
  renderer.setClearColor(0x10131f, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x10131f, 0.032);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
  camera.position.set(0, 0, 14);

  scene.add(new THREE.AmbientLight(0xc7d2ef, 2.35));
  const key = new THREE.DirectionalLight(0xfff3f5, 5.2);
  key.position.set(-5, 7, 10);
  scene.add(key);
  const rim = new THREE.PointLight(0x6e9cff, 72, 32, 2);
  rim.position.set(7, -4, 4);
  scene.add(rim);
  const warm = new THREE.PointLight(ACCENT_COLOR, 26, 24, 2);
  warm.position.set(-7, -3, 2);
  scene.add(warm);

  // 対称性の高い立体だけを語彙とする。個体はここから選ぶだけで、形は生成しない。
  const geometries = [
    new THREE.TetrahedronGeometry(1),
    new THREE.OctahedronGeometry(1),
    new THREE.IcosahedronGeometry(1),
    new THREE.DodecahedronGeometry(1),
    new THREE.BoxGeometry(1.3, 1.3, 1.3),
    new THREE.TorusGeometry(1, 0.3, 16, 40),
  ];
  const materials = BODY_COLORS.map((color, index) => new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.18 + index * 0.03,
    metalness: 0.03,
    clearcoat: 0.94,
    clearcoatRoughness: 0.18,
  }));
  const accentMaterial = new THREE.MeshPhysicalMaterial({
    color: ACCENT_COLOR, roughness: 0.2, metalness: 0.03, clearcoat: 0.94, clearcoatRoughness: 0.18,
  });
  const nearAccentMaterial = new THREE.MeshPhysicalMaterial({
    color: NEAR_ACCENT_COLOR, roughness: 0.22, metalness: 0.02, clearcoat: 0.9, clearcoatRoughness: 0.2,
  });
  const secondaryAccentMaterial = new THREE.MeshPhysicalMaterial({
    color: SECONDARY_ACCENT_COLOR, roughness: 0.24, metalness: 0.02, clearcoat: 0.86, clearcoatRoughness: 0.22,
  });

  // 決定的な乱数。起動のたびに同じ配置から漂流を始める。
  let seed = 0x20115;
  // 決定的な [0,1) 乱数。
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  interface Drift {
    readonly mesh: THREE.Mesh;
    readonly base: THREE.Vector3;
    readonly baseRotation: THREE.Euler;
    readonly phase: number;
    readonly speed: number;
    readonly amplitude: number;
  }
  const bodies: Drift[] = [];
  for (let i = 0; i < BODY_COUNT; i += 1) {
    const geometry = geometries[i % geometries.length]!;
    const material = i === ACCENT_INDEX ? accentMaterial
      : i === NEAR_ACCENT_INDEX ? nearAccentMaterial
        : i === SECONDARY_ACCENT_INDEX ? secondaryAccentMaterial
          : materials[Math.floor(random() * materials.length)]!;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.setScalar(0.42 + random() * 0.78);
    mesh.position.set((random() - 0.5) * 15.5, (random() - 0.5) * 9.3, -5.5 + random() * 7.2);
    mesh.rotation.set(random() * Math.PI, random() * Math.PI, random() * Math.PI);
    scene.add(mesh);
    bodies.push({
      mesh,
      base: mesh.position.clone(),
      baseRotation: mesh.rotation.clone(),
      phase: random() * Math.PI * 2,
      speed: 0.035 + random() * 0.075,
      amplitude: 0.08 + random() * 0.26,
    });
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let pointerX = 0;
  let pointerY = 0;
  // ポインタ位置を視野中心からの ±0.5 の比率として覚える。カメラはこれへ遅れて追随する。
  const onPointerMove = (e: PointerEvent) => {
    const rect = pointerTarget.getBoundingClientRect();
    pointerX = (e.clientX - rect.left) / rect.width - 0.5;
    pointerY = (e.clientY - rect.top) / rect.height - 0.5;
  };
  const onPointerLeave = () => { pointerX = 0; pointerY = 0; };
  pointerTarget.addEventListener('pointermove', onPointerMove, { passive: true });
  pointerTarget.addEventListener('pointerleave', onPointerLeave);

  // canvas の CSS 寸法へ描画解像度と投影行列を合わせる。
  const resize = () => {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    if (document.hidden) return;
    const t = reduced.matches ? 0 : clock.getElapsedTime();
    for (let i = 0; i < bodies.length; i += 1) {
      const b = bodies[i]!;
      b.mesh.position.set(
        b.base.x + Math.sin(t * b.speed + b.phase) * b.amplitude,
        b.base.y + Math.cos(t * b.speed * 0.73 + b.phase) * b.amplitude * 0.72,
        b.base.z + Math.sin(t * b.speed * 0.42 + b.phase) * b.amplitude * 0.45,
      );
      b.mesh.rotation.x = b.baseRotation.x + t * b.speed * (i % 2 ? 0.34 : -0.28);
      b.mesh.rotation.y = b.baseRotation.y + t * b.speed * (i % 3 ? -0.25 : 0.38);
    }
    const targetX = reduced.matches ? 0 : pointerX * 0.55;
    const targetY = reduced.matches ? 0 : -pointerY * 0.36;
    camera.position.x += (targetX - camera.position.x) * 0.025;
    camera.position.y += (targetY - camera.position.y) * 0.025;
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  });

  return {
    // アニメーションループとリスナーを止め、ジオメトリ・材質・レンダラーを解放する。
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      pointerTarget.removeEventListener('pointermove', onPointerMove);
      pointerTarget.removeEventListener('pointerleave', onPointerLeave);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      accentMaterial.dispose();
      nearAccentMaterial.dispose();
      secondaryAccentMaterial.dispose();
      renderer.dispose();
    },
  };
}
