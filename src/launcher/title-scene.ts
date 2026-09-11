// タイトル画面の背景となる3D場面。タンパク質を抽象化した形(捻れたチューブ、枝分かれするロッド、
// 結節、リング、カプセル)を光沢プラスチックで多数配置し、ゆっくり漂わせる。
import * as THREE from 'three/webgpu';
import { ACCENT, ACCENT_SOFT, BG, SIGNAL } from '../theme';

// 背景の図案。図案ごとに物体の並べ方と形の組み合わせが変わる。
export const TITLE_SCENE_PATTERNS = ['mosaic', 'helix', 'orbital', 'lattice'] as const;
type TitleScenePattern = typeof TITLE_SCENE_PATTERNS[number];

// 図案ごとの物体の数。
const OBJECT_COUNTS: Readonly<Record<TitleScenePattern, number>> = {
  mosaic: 26,
  helix: 26,
  orbital: 26,
  lattice: 25,
};

// 地の材質の色。乳白・煙色・黒・暖灰色。
const BODY_COLORS = [0xf1edf0, 0xa8aec0, 0x48506a, 0xd6d6d0] as const;
const BG_COLOR = Number.parseInt(BG.slice(1), 16);
// 有彩色の材質を割り当てる物体の通し番号。有彩色は少数へ絞り、残りは地の材質にする。
const ACCENT_INDICES = new Set([6, 18]);
const ACCENT_SOFT_INDICES = new Set([11, 22]);
const SIGNAL_INDEX = 15;

// 図案の材質一式。物体の通し番号ごとに、地の材質か少数の有彩色を割り当てる。
class TitleSceneMaterials {
  private readonly body = BODY_COLORS.map((color, index) => new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.18 + index * 0.03,
    metalness: 0.03,
    clearcoat: 0.94,
    clearcoatRoughness: 0.18,
  }));
  private readonly accent = new THREE.MeshPhysicalMaterial({
    color: ACCENT, roughness: 0.2, metalness: 0.03, clearcoat: 0.94, clearcoatRoughness: 0.18,
  });
  private readonly accentSoft = new THREE.MeshPhysicalMaterial({
    color: ACCENT_SOFT, roughness: 0.22, metalness: 0.02, clearcoat: 0.9, clearcoatRoughness: 0.2,
  });
  private readonly signal = new THREE.MeshPhysicalMaterial({
    color: SIGNAL, roughness: 0.19, metalness: 0.02, clearcoat: 1, clearcoatRoughness: 0.12,
  });

  // index 番目の物体の材質。
  public forIndex(index: number): THREE.MeshPhysicalMaterial {
    if (ACCENT_INDICES.has(index)) return this.accent;
    if (ACCENT_SOFT_INDICES.has(index)) return this.accentSoft;
    if (index === SIGNAL_INDEX) return this.signal;
    return this.body[index % this.body.length]!;
  }

  // 全材質を解放する。
  public dispose(): void {
    for (const material of this.body) material.dispose();
    this.accent.dispose();
    this.accentSoft.dispose();
    this.signal.dispose();
  }
}

// 半球光と主光源に、アクセント色・Signal 色の差し色の点光源を添えて scene へ加える。
function addLights(scene: THREE.Scene): void {
  // 地の明るさと主光源。
  scene.add(new THREE.HemisphereLight(0xe8e4f0, 0x121418, 2.2));
  const key = new THREE.PointLight(0xffffff, 100, 40, 1.4);
  key.position.set(-5, 7, 9);
  scene.add(key);
  // 差し色。
  const accentLight = new THREE.PointLight(ACCENT, 70, 28, 1.6);
  accentLight.position.set(7, -2, 6);
  scene.add(accentLight);
  const signalLight = new THREE.PointLight(SIGNAL, 28, 24, 1.7);
  signalLight.position.set(-7, -5, 2);
  scene.add(signalLight);
}

// from から to へ伸びる半径 radius の円柱を group へ加える。
function addRod(
  group: THREE.Group,
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.MeshPhysicalMaterial,
): void {
  const delta = new THREE.Vector3().subVectors(to, from);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, delta.length(), 18, 1), material);
  rod.position.copy(from).add(to).multiplyScalar(0.5);
  rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  group.add(rod);
}

// 折れ線の字形。variant で線の太さ・本数と、先端の結節の有無が変わる。
function createGlyph(material: THREE.MeshPhysicalMaterial, variant: number): THREE.Group {
  const group = new THREE.Group();
  const radius = 0.13 + (variant % 2) * 0.04;
  addRod(group, new THREE.Vector3(-0.8, -0.9, 0), new THREE.Vector3(-0.15, 0.95, 0.1), radius, material);
  addRod(group, new THREE.Vector3(-0.15, 0.95, 0.1), new THREE.Vector3(0.72, 0.35, -0.05), radius, material);
  // variant ごとの付け足し。
  if (variant % 3 !== 0) addRod(group, new THREE.Vector3(-0.46, 0.05, 0.04), new THREE.Vector3(0.48, -0.42, 0), radius, material);
  if (variant % 2 === 0) {
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.24, 20, 14), material);
    bead.position.set(0.72, 0.35, -0.05);
    group.add(bead);
  }
  return group;
}

// 曲がったチューブから小枝が伸びる形。variant で小枝の向きと本数が変わる。
function createBranch(material: THREE.MeshPhysicalMaterial, variant: number): THREE.Group {
  const group = new THREE.Group();
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.8, -0.9, 0),
    new THREE.Vector3(-0.35, -0.18, 0.25),
    new THREE.Vector3(0.1, 0.26, -0.18),
    new THREE.Vector3(0.65, 0.96, 0.05),
  ]);
  group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 0.13, 12, false), material));
  // 小枝。
  addRod(group, new THREE.Vector3(-0.12, 0.1, 0), new THREE.Vector3(0.78, 0.36 + variant * 0.03, 0.22), 0.1, material);
  if (variant % 2 === 0) addRod(group, new THREE.Vector3(0.14, 0.3, 0), new THREE.Vector3(-0.62, 0.68, -0.24), 0.09, material);
  return group;
}

// 広がりながら巻く螺旋のチューブ。variant で巻きの位相と、中ほどの結節の有無が変わる。
function createHelix(material: THREE.MeshPhysicalMaterial, variant: number): THREE.Group {
  const group = new THREE.Group();
  // 巻きの芯線。
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
  group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 36, 0.12, 12, false), material));
  // 中ほどの結節。
  if (variant % 2 === 0) {
    const node = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 12), material);
    node.position.copy(points[4]!);
    group.add(node);
  }
  return group;
}

// 一部が欠けたリング。
function createRing(material: THREE.MeshPhysicalMaterial): THREE.Mesh {
  return new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.16, 16, 44, Math.PI * 1.62), material);
}

// 結び目。
function createKnot(material: THREE.MeshPhysicalMaterial): THREE.Mesh {
  return new THREE.Mesh(new THREE.TorusKnotGeometry(0.52, 0.13, 72, 12, 2, 3), material);
}

// カプセル。
function createCapsule(material: THREE.MeshPhysicalMaterial): THREE.Mesh {
  return new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 1.45, 8, 18), material);
}

// pattern の図案で index 番目に置く形。図案ごとの形の組を、通し番号の順に巡回させる。
function shapeAt(pattern: TitleScenePattern, index: number, material: THREE.MeshPhysicalMaterial): THREE.Object3D {
  // slot は形の組の中で巡回する位置。
  switch (pattern) {
    case 'mosaic': {
      const slot = index % 5;
      if (slot === 0) return createBranch(material, index % 4);
      if (slot === 1) return createGlyph(material, index);
      if (slot === 2) return createRing(material);
      if (slot === 3) return createKnot(material);
      return createCapsule(material);
    }
    case 'helix': {
      const slot = index % 4;
      if (slot === 0) return createHelix(material, slot);
      if (slot === 1) return createBranch(material, slot);
      if (slot === 2) return createKnot(material);
      return createCapsule(material);
    }
    case 'orbital': {
      const slot = index % 4;
      if (slot === 0) return createRing(material);
      if (slot === 1) return createGlyph(material, index);
      if (slot === 2) return createBranch(material, slot);
      return createCapsule(material);
    }
    case 'lattice': {
      const slot = index % 4;
      if (slot === 0) return createBranch(material, slot);
      if (slot === 1) return createGlyph(material, index);
      if (slot === 2) return createRing(material);
      return createHelix(material, slot);
    }
  }
}

// pattern の図案で count 個のうち index 番目を置く基準位置。図案によっては random から乱数を引く。
function baseAt(pattern: TitleScenePattern, index: number, count: number, random: () => number): THREE.Vector3 {
  const progress = index / Math.max(1, count - 1);
  switch (pattern) {
    case 'mosaic': {
      // 横長の楕円の範囲へ散らす。
      const angle = random() * Math.PI * 2;
      const radius = 2.5 + random() * 7;
      return new THREE.Vector3(Math.cos(angle) * radius * 1.28, Math.sin(angle) * radius * 0.7, -4 + random() * 9);
    }
    case 'helix': {
      // 奥から手前へ広がりながら巻く螺旋に並べる。
      const phase = progress * Math.PI * 6.2;
      const radius = 2.2 + progress * 4.8;
      return new THREE.Vector3(
        Math.cos(phase) * radius * 1.05,
        Math.sin(phase) * radius * 0.48,
        -4.8 + progress * 9.6,
      );
    }
    case 'orbital': {
      // 半径の違う4本の楕円軌道へ振り分けて並べる。
      const phase = progress * Math.PI * 2;
      const radius = 3 + (index % 4) * 1.25;
      return new THREE.Vector3(
        Math.cos(phase + (index % 2) * 0.18) * radius * 1.35,
        Math.sin(phase + (index % 2) * 0.18) * radius * 0.5,
        -3.8 + Math.sin(phase * 2) * 3.5,
      );
    }
    case 'lattice': {
      // 5列の格子に、わずかな揺らぎを持たせて並べる。
      const columns = 5;
      const column = index % columns;
      const row = Math.floor(index / columns);
      return new THREE.Vector3(
        (column - 2) * 2.3 + (random() - 0.5) * 0.38,
        (row - 2) * 1.9 + (random() - 0.5) * 0.34,
        -1.8 + (random() - 0.5) * 6.5,
      );
    }
  }
}

// seed から決まる [0,1) の乱数列。同じ seed からは同じ配置になる。
function linearCongruential(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// 漂う物体1つ。基準の位置と姿勢のまわりを、位相と速さの違う正弦波で揺れる。
interface Drift {
  readonly object: THREE.Object3D;
  readonly base: THREE.Vector3;
  readonly baseRotation: THREE.Euler;
  readonly phase: number;
  readonly speed: number;
  readonly amplitude: number;
}

// pattern の図案の物体を seed から決まる配置で作り、それぞれの漂い方と組にして返す。
function createDrifts(pattern: TitleScenePattern, materials: TitleSceneMaterials, seed: number): readonly Drift[] {
  const random = linearCongruential(seed);
  const count = OBJECT_COUNTS[pattern];
  const drifts: Drift[] = [];
  for (let i = 0; i < count; i += 1) {
    // 乱数を引く順序を入れ替えると、同じ seed でも配置が変わる。
    const object = shapeAt(pattern, i, materials.forIndex(i));
    const base = baseAt(pattern, i, count, random);
    object.position.copy(base);
    object.rotation.set(random() * Math.PI, random() * Math.PI, random() * Math.PI);
    object.scale.setScalar(0.52 + random() * 1.15);
    drifts.push({
      object,
      base,
      baseRotation: object.rotation.clone(),
      phase: random() * Math.PI * 2,
      speed: 0.08 + random() * 0.1,
      amplitude: 0.34,
    });
  }
  return drifts;
}

// タイトル画面の3D場面。canvas の CSS 寸法に追従して dispose まで描き続け、
// pointerTarget 上のポインタ移動へカメラがわずかに追随する。
export class TitleScene {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  private readonly materials = new TitleSceneMaterials();
  private readonly drifts: readonly Drift[];
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly resizeObserver = new ResizeObserver(() => this.resize());
  private readonly clock = new THREE.Clock();

  // ポインタ位置。視野中心からの ±0.5 の比率で、カメラはこれへ遅れて追随する。
  private pointerX = 0;
  private pointerY = 0;
  // pointerTarget 上のポインタ位置を覚える。
  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.pointerTarget.getBoundingClientRect();
    this.pointerX = (e.clientX - rect.left) / rect.width - 0.5;
    this.pointerY = (e.clientY - rect.top) / rect.height - 0.5;
  };
  // ポインタが外れたら視野中心へ戻す。
  private readonly onPointerLeave = (): void => {
    this.pointerX = 0;
    this.pointerY = 0;
  };

  // canvas へ pattern の図案を seed から決まる配置で組み、回し始める。
  public static async create(
    canvas: HTMLCanvasElement,
    pointerTarget: HTMLElement,
    pattern: TitleScenePattern,
    seed: number,
  ): Promise<TitleScene> {
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    await renderer.init();
    return new TitleScene(renderer, canvas, pointerTarget, pattern, seed);
  }

  // 初期化済みの renderer へ場面を組み、回し始める。
  private constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly canvas: HTMLCanvasElement,
    private readonly pointerTarget: HTMLElement,
    pattern: TitleScenePattern,
    seed: number,
  ) {
    // 背景色へ溶ける霧の中に、光源と図案を置く。
    renderer.setClearColor(BG_COLOR, 1);
    this.scene.fog = new THREE.FogExp2(BG_COLOR, 0.038);
    this.camera.position.set(0, 0, 17);
    addLights(this.scene);
    const root = new THREE.Group();
    root.rotation.z = -0.08;
    this.drifts = createDrifts(pattern, this.materials, seed);
    root.add(...this.drifts.map((drift) => drift.object));
    this.scene.add(root);

    // ポインタとリサイズを追い、描画ループを回し始める。
    pointerTarget.addEventListener('pointermove', this.onPointerMove, { passive: true });
    pointerTarget.addEventListener('pointerleave', this.onPointerLeave);
    this.resizeObserver.observe(canvas);
    this.resize();
    renderer.setAnimationLoop(() => this.renderFrame());
  }

  // 破棄。アニメーションループとリスナーを止め、ジオメトリ・材質・レンダラーを解放する。
  public dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.pointerTarget.removeEventListener('pointermove', this.onPointerMove);
    this.pointerTarget.removeEventListener('pointerleave', this.onPointerLeave);
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    this.materials.dispose();
    this.renderer.dispose();
  }

  // canvas の CSS 寸法へ描画解像度と投影行列を合わせる。
  private resize(): void {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // 経過時間に応じて物体を漂わせ、1フレーム描く。動きを減らす設定では静止させる。
  private renderFrame(): void {
    const t = this.reducedMotion.matches ? 0 : this.clock.getElapsedTime();
    for (const [i, drift] of this.drifts.entries()) {
      drift.object.position.set(
        drift.base.x + Math.sin(t * drift.speed + drift.phase) * drift.amplitude,
        drift.base.y + Math.cos(t * drift.speed * 0.82 + drift.phase) * 0.26,
        drift.base.z + Math.sin(t * drift.speed * 0.57 + drift.phase) * 0.22,
      );
      drift.object.rotation.x = drift.baseRotation.x + t * drift.speed * (i % 2 ? 0.34 : -0.28);
      drift.object.rotation.y = drift.baseRotation.y + t * drift.speed * (i % 3 ? -0.25 : 0.38);
      drift.object.rotation.z = drift.baseRotation.z + t * drift.speed * (i % 4 ? 0.14 : -0.18);
    }
    // カメラはポインタへ遅れて追随し、常に原点を向く。
    const targetX = this.reducedMotion.matches ? 0 : this.pointerX * 0.55;
    const targetY = this.reducedMotion.matches ? 0 : -this.pointerY * 0.36;
    this.camera.position.x += (targetX - this.camera.position.x) * 0.025;
    this.camera.position.y += (targetY - this.camera.position.y) * 0.025;
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }
}
