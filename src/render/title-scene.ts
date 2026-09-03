// タイトル画面の背景となる3D場面。モックアップのタンパク質図案を参照し、
// 捻れたチューブ、枝分かれするロッド、結節、リング、カプセルを光沢プラスチックで
// 抽象化して多数配置する。ゲーム世界とは無関係な表示専用の場面なので physics/ も参照しない。
// ゲーム世界とは無関係な表示専用の場面なので、physics/ も game/ も参照しない。
import * as THREE from 'three/webgpu';
import { ACCENT, ACCENT_SECONDARY, ACCENT_SOFT, BG } from '../theme';

export const TITLE_SCENE_PATTERNS = ['mosaic', 'helix', 'orbital', 'lattice'] as const;
type TitleScenePattern = typeof TITLE_SCENE_PATTERNS[number];

interface TitleSceneOptions {
  readonly pattern?: TitleScenePattern;
  readonly seed?: number;
}

// 材質。roughness 0.16–0.28 / metalness 0–0.06 / clearcoat 0.7–1.0 の光沢プラスチック帯。
const BODY_COLORS = [0xf1edf0, 0xa8aec0, 0x48506a, 0xd6d6d0] as const;
const ACCENT_COLOR = ACCENT;
const NEAR_ACCENT_COLOR = ACCENT_SOFT;
const SECONDARY_ACCENT_COLOR = ACCENT_SECONDARY;
const BG_COLOR = Number.parseInt(BG.slice(1), 16);
// V6 §5.2 に従い、有彩色の図案は少数へ絞り、残りを乳白・煙色・黒・暖灰色で構成する。
const ACCENT_INDICES = new Set([6, 18]);
const NEAR_ACCENT_INDICES = new Set([11, 22]);
const SECONDARY_ACCENT_INDEX = 15;

interface PatternConfig {
  readonly count: number;
  readonly layout: 'scatter' | 'helix' | 'orbital' | 'lattice';
}

const PATTERN_CONFIGS: Readonly<Record<TitleScenePattern, PatternConfig>> = {
  mosaic: { count: 26, layout: 'scatter' },
  helix: { count: 26, layout: 'helix' },
  orbital: { count: 26, layout: 'orbital' },
  lattice: { count: 25, layout: 'lattice' },
};

export interface TitleScene {
  // 破棄。アニメーションループとリスナーを止め、GPU 資源を解放する。
  dispose(): void;
}

// canvas へ 3D 場面を構築して回し始める。canvas の CSS 寸法に追従し、
// pointerTarget 上のポインタ移動へカメラがわずかに追随する。
export async function createTitleScene(
  canvas: HTMLCanvasElement,
  pointerTarget: HTMLElement,
  options: TitleSceneOptions = {},
): Promise<TitleScene> {
  const pattern = options.pattern ?? 'mosaic';
  const patternConfig = PATTERN_CONFIGS[pattern];
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  await renderer.init();
  renderer.setClearColor(BG_COLOR, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(BG_COLOR, 0.038);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 17);

  scene.add(new THREE.HemisphereLight(0xe8e4f0, 0x121418, 2.2));
  const key = new THREE.PointLight(0xffffff, 100, 40, 1.4);
  key.position.set(-5, 7, 9);
  scene.add(key);
  const accentLight = new THREE.PointLight(ACCENT_COLOR, 70, 28, 1.6);
  accentLight.position.set(7, -2, 6);
  scene.add(accentLight);
  const signalLight = new THREE.PointLight(SECONDARY_ACCENT_COLOR, 28, 24, 1.7);
  signalLight.position.set(-7, -5, 2);
  scene.add(signalLight);

  const geometries: THREE.BufferGeometry[] = [];
  const registerGeometry = <T extends THREE.BufferGeometry>(geometry: T): T => {
    geometries.push(geometry);
    return geometry;
  };
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
    color: SECONDARY_ACCENT_COLOR, roughness: 0.19, metalness: 0.02, clearcoat: 1, clearcoatRoughness: 0.12,
  });

  const rootGroup = new THREE.Group();
  rootGroup.rotation.z = -0.08;
  scene.add(rootGroup);

  // 決定的な乱数。起動のたびに同じ配置から漂流を始める。
  let seed = options.seed ?? 0x20115;
  // 決定的な [0,1) 乱数。
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  interface Drift {
    readonly object: THREE.Object3D;
    readonly base: THREE.Vector3;
    readonly baseRotation: THREE.Euler;
    readonly phase: number;
    readonly speed: number;
    readonly amplitude: number;
  }
  const addRod = (
    group: THREE.Group,
    from: THREE.Vector3,
    to: THREE.Vector3,
    radius: number,
    material: THREE.MeshPhysicalMaterial,
  ): void => {
    const delta = new THREE.Vector3().subVectors(to, from);
    const rod = new THREE.Mesh(registerGeometry(new THREE.CylinderGeometry(radius, radius, delta.length(), 18, 1)), material);
    rod.position.copy(from).add(to).multiplyScalar(0.5);
    rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    group.add(rod);
  };

  const createGlyph = (material: THREE.MeshPhysicalMaterial, variant: number): THREE.Group => {
    const group = new THREE.Group();
    const radius = 0.13 + (variant % 2) * 0.04;
    addRod(group, new THREE.Vector3(-0.8, -0.9, 0), new THREE.Vector3(-0.15, 0.95, 0.1), radius, material);
    addRod(group, new THREE.Vector3(-0.15, 0.95, 0.1), new THREE.Vector3(0.72, 0.35, -0.05), radius, material);
    if (variant % 3 !== 0) addRod(group, new THREE.Vector3(-0.46, 0.05, 0.04), new THREE.Vector3(0.48, -0.42, 0), radius, material);
    if (variant % 2 === 0) {
      const bead = new THREE.Mesh(registerGeometry(new THREE.SphereGeometry(0.24, 20, 14)), material);
      bead.position.set(0.72, 0.35, -0.05);
      group.add(bead);
    }
    return group;
  };

  const createBranch = (material: THREE.MeshPhysicalMaterial, variant: number): THREE.Group => {
    const group = new THREE.Group();
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.8, -0.9, 0),
      new THREE.Vector3(-0.35, -0.18, 0.25),
      new THREE.Vector3(0.1, 0.26, -0.18),
      new THREE.Vector3(0.65, 0.96, 0.05),
    ]);
    group.add(new THREE.Mesh(registerGeometry(new THREE.TubeGeometry(curve, 32, 0.13, 12, false)), material));
    addRod(group, new THREE.Vector3(-0.12, 0.1, 0), new THREE.Vector3(0.78, 0.36 + variant * 0.03, 0.22), 0.1, material);
    if (variant % 2 === 0) addRod(group, new THREE.Vector3(0.14, 0.3, 0), new THREE.Vector3(-0.62, 0.68, -0.24), 0.09, material);
    return group;
  };

  const createHelix = (material: THREE.MeshPhysicalMaterial, variant: number): THREE.Group => {
    const group = new THREE.Group();
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < 9; i += 1) {
      const phase = (i / 8) * Math.PI * 2.3 + variant * 0.4;
      points.push(new THREE.Vector3(
        Math.cos(phase) * (0.48 + i * 0.03),
        -0.95 + i * 0.24,
        Math.sin(phase) * (0.48 + i * 0.03),
      ));
    }
    const curve = new THREE.CatmullRomCurve3(points);
    group.add(new THREE.Mesh(registerGeometry(new THREE.TubeGeometry(curve, 36, 0.12, 12, false)), material));
    if (variant % 2 === 0) {
      const node = new THREE.Mesh(registerGeometry(new THREE.SphereGeometry(0.2, 18, 12)), material);
      node.position.copy(points[4]!);
      group.add(node);
    }
    return group;
  };

  const materialForIndex = (index: number): THREE.MeshPhysicalMaterial => {
    if (ACCENT_INDICES.has(index)) return accentMaterial;
    if (NEAR_ACCENT_INDICES.has(index)) return nearAccentMaterial;
    if (index === SECONDARY_ACCENT_INDEX) return secondaryAccentMaterial;
    return materials[index % materials.length]!;
  };

  const baseForIndex = (index: number): THREE.Vector3 => {
    const progress = index / Math.max(1, patternConfig.count - 1);
    if (patternConfig.layout === 'helix') {
      const phase = progress * Math.PI * 6.2;
      const radius = 2.2 + progress * 4.8;
      return new THREE.Vector3(
        Math.cos(phase) * radius * 1.05,
        Math.sin(phase) * radius * 0.48,
        -4.8 + progress * 9.6,
      );
    }
    if (patternConfig.layout === 'orbital') {
      const phase = progress * Math.PI * 2;
      const radius = 3 + (index % 4) * 1.25;
      return new THREE.Vector3(
        Math.cos(phase + (index % 2) * 0.18) * radius * 1.35,
        Math.sin(phase + (index % 2) * 0.18) * radius * 0.5,
        -3.8 + Math.sin(phase * 2) * 3.5,
      );
    }
    if (patternConfig.layout === 'lattice') {
      const columns = 5;
      const column = index % columns;
      const row = Math.floor(index / columns);
      return new THREE.Vector3(
        (column - 2) * 2.3 + (random() - 0.5) * 0.38,
        (row - 2) * 1.9 + (random() - 0.5) * 0.34,
        -1.8 + (random() - 0.5) * 6.5,
      );
    }
    const angle = random() * Math.PI * 2;
    const radius = 2.5 + random() * 7;
    return new THREE.Vector3(Math.cos(angle) * radius * 1.28, Math.sin(angle) * radius * 0.7, -4 + random() * 9);
  };

  const objectForIndex = (index: number, material: THREE.MeshPhysicalMaterial): THREE.Object3D => {
    if (pattern === 'helix') {
      if (index % 4 === 0) return createHelix(material, index % 4);
      if (index % 4 === 1) return createBranch(material, index % 4);
      if (index % 4 === 2) return new THREE.Mesh(registerGeometry(new THREE.TorusKnotGeometry(0.52, 0.13, 72, 12, 2, 3)), material);
      return new THREE.Mesh(registerGeometry(new THREE.CapsuleGeometry(0.24, 1.45, 8, 18)), material);
    }
    if (pattern === 'orbital') {
      if (index % 4 === 0) return new THREE.Mesh(registerGeometry(new THREE.TorusGeometry(0.72, 0.16, 16, 44, Math.PI * 1.62)), material);
      if (index % 4 === 1) return createGlyph(material, index);
      if (index % 4 === 2) return createBranch(material, index % 4);
      return new THREE.Mesh(registerGeometry(new THREE.CapsuleGeometry(0.24, 1.45, 8, 18)), material);
    }
    if (pattern === 'lattice') {
      if (index % 4 === 0) return createBranch(material, index % 4);
      if (index % 4 === 1) return createGlyph(material, index);
      if (index % 4 === 2) return new THREE.Mesh(registerGeometry(new THREE.TorusGeometry(0.72, 0.16, 16, 44, Math.PI * 1.62)), material);
      return createHelix(material, index % 4);
    }
    if (index % 5 === 0) return createBranch(material, index % 4);
    if (index % 5 === 1) return createGlyph(material, index);
    if (index % 5 === 2) return new THREE.Mesh(registerGeometry(new THREE.TorusGeometry(0.72, 0.16, 16, 44, Math.PI * 1.62)), material);
    if (index % 5 === 3) return new THREE.Mesh(registerGeometry(new THREE.TorusKnotGeometry(0.52, 0.13, 72, 12, 2, 3)), material);
    return new THREE.Mesh(registerGeometry(new THREE.CapsuleGeometry(0.24, 1.45, 8, 18)), material);
  };

  const bodies: Drift[] = [];
  for (let i = 0; i < patternConfig.count; i += 1) {
    const material = materialForIndex(i);
    const object = objectForIndex(i, material);
    const base = baseForIndex(i);
    object.position.copy(base);
    object.rotation.set(random() * Math.PI, random() * Math.PI, random() * Math.PI);
    object.scale.setScalar(0.52 + random() * 1.15);
    rootGroup.add(object);
    bodies.push({
      object,
      base,
      baseRotation: object.rotation.clone(),
      phase: random() * Math.PI * 2,
      speed: 0.08 + random() * 0.1,
      amplitude: 0.34,
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
    const t = reduced.matches ? 0 : clock.getElapsedTime();
    for (let i = 0; i < bodies.length; i += 1) {
      const b = bodies[i]!;
      b.object.position.set(
        b.base.x + Math.sin(t * b.speed + b.phase) * b.amplitude,
        b.base.y + Math.cos(t * b.speed * 0.82 + b.phase) * 0.26,
        b.base.z + Math.sin(t * b.speed * 0.57 + b.phase) * 0.22,
      );
      b.object.rotation.x = b.baseRotation.x + t * b.speed * (i % 2 ? 0.34 : -0.28);
      b.object.rotation.y = b.baseRotation.y + t * b.speed * (i % 3 ? -0.25 : 0.38);
      b.object.rotation.z = b.baseRotation.z + t * b.speed * (i % 4 ? 0.14 : -0.18);
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
