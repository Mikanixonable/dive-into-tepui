// 敵の実験環境の舞台。調整値から組んだ個体を格子に並べ、軌道カメラで眺め、弾を撃ち込んで
// 部品が壊れて飛ぶ様子を試せる。ゲーム本体の描画経路(大気・影・露出)は使わず、素の光源で形を読む —
// ここで見るのは形と被弾の挙動であって、描画品質ではない(描画は render-lab)。
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { assemblyPartMesh } from '../../src/render/assembly/assembly-part-mesh';
import { detachPart, generateAssemblyShape, type AssemblyShape } from '../../src/physics/assembly-shape';
import type { AssemblyTuning } from '../../src/physics/assembly-tuning';
import { AssemblyCombatState, ASSEMBLY_PART_HP } from '../../src/game/enemy-assembly/assembly-combat-state';

const ACCENT = 0xff4a3d;
// 格子の列数と、個体どうしの間隔(個体の最大外接半径に対する倍率)。
const GRID_COLUMNS = 4;
const SPACING_FACTOR = 2.2;
// 個体のゆるやかな自転の角速度 [rad/s]。
const TUMBLE_RATE = 0.15;
// 飛んだ部品の速度 [m/s]・回転 [rad/s]・寿命 [s]。
const DEBRIS_SPEED = 6;
const DEBRIS_SPIN = 0.8;
const DEBRIS_LIFETIME = 10;
// 選んだ個体を寄って見るときの距離(外接半径に対する倍率)。
const FOCUS_DISTANCE_FACTOR = 3.4;

export type StudioMode = 'look' | 'shoot';

// 選んだ個体の被弾状況。
export interface IndividualReadout {
  readonly seed: number;
  readonly parts: number;
  readonly outerRadius: number;
  readonly integrity: number;
  readonly maxIntegrity: number;
  readonly emitterAlive: boolean;
  readonly destroyed: boolean;
  readonly lost: number;
  readonly inertia: { readonly x: number; readonly y: number; readonly z: number };
}

interface Individual {
  readonly seed: number;
  readonly shape: AssemblyShape;
  readonly group: THREE.Group;
  readonly meshes: THREE.Mesh[];
  readonly combat: AssemblyCombatState;
  readonly spinAxis: THREE.Vector3;
}

interface Debris {
  readonly mesh: THREE.Mesh;
  readonly velocity: THREE.Vector3;
  readonly spinAxis: THREE.Vector3;
  age: number;
}

export class StudioScene {
  private readonly renderer: THREE.WebGPURenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private individuals: Individual[] = [];
  private debris: Debris[] = [];
  private selected = 0;
  private mode: StudioMode = 'look';
  private damage = 1;
  private tuning: AssemblyTuning;
  private firstSeed = 0;
  private count = 12;
  private spacing = 200;
  private pointerDown: { x: number; y: number } | null = null;
  public onReadout: (readout: IndividualReadout | null) => void = () => {};
  public onSelect: (index: number) => void = () => {};

  public constructor(private readonly canvas: HTMLCanvasElement, tuning: AssemblyTuning) {
    this.tuning = tuning;
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.scene.background = new THREE.Color(0x07090c);
    const sun = new THREE.DirectionalLight(0xfff4e6, 3.2);
    sun.position.set(300, 500, 400);
    this.scene.add(sun, new THREE.AmbientLight(0x8fa0c0, 0.6));
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    canvas.addEventListener('pointerdown', (e) => { this.pointerDown = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
  }

  public async init(): Promise<void> {
    await this.renderer.init();
    this.rebuild();
    this.focusAll();
    this.renderer.setAnimationLoop((time) => this.frame(time));
  }

  // 描画域の大きさを合わせる。
  public resize(width: number, height: number): void {
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // 調整値を差し替えて、個体を組み直す(被弾は無傷へ戻る)。
  public setTuning(tuning: AssemblyTuning): void {
    this.tuning = tuning;
    this.rebuild();
  }

  // seed の始点と個体数を差し替える。
  public setSeeds(firstSeed: number, count: number): void {
    this.firstSeed = firstSeed;
    this.count = count;
    this.rebuild();
    this.focusAll();
  }

  public setMode(mode: StudioMode): void { this.mode = mode; }
  public setDamage(damage: number): void { this.damage = damage; }

  // 全員を無傷へ戻す。
  public repair(): void { this.rebuild(); }

  public selectedIndex(): number { return this.selected; }

  // 格子全体が収まる位置へカメラを引く。
  public focusAll(): void {
    const rows = Math.ceil(this.count / GRID_COLUMNS);
    const cols = Math.min(this.count, GRID_COLUMNS);
    const width = cols * this.spacing;
    const height = rows * this.spacing;
    const distance = Math.max(width / this.camera.aspect, height) * 1.15 / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(0, 0, distance);
    this.controls.update();
  }

  // index の個体を選び、寄って見る。
  public select(index: number): void {
    const individual = this.individuals[index];
    if (individual === undefined) return;
    this.selected = index;
    this.controls.target.copy(individual.group.position);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(
      direction, individual.shape.outerRadius * FOCUS_DISTANCE_FACTOR,
    );
    this.controls.update();
    this.onSelect(index);
    this.publishReadout();
  }

  // 個体を全部組み直して格子へ並べる。
  private rebuild(): void {
    for (const individual of this.individuals) this.disposeGroup(individual.group);
    for (const piece of this.debris) this.disposeGroup(piece.mesh);
    this.individuals = [];
    this.debris = [];
    this.spacing = this.tuning.outerRadiusMax * SPACING_FACTOR;
    const rows = Math.ceil(this.count / GRID_COLUMNS);
    const cols = Math.min(this.count, GRID_COLUMNS);
    for (let i = 0; i < this.count; i += 1) {
      const seed = this.firstSeed + i;
      const shape = generateAssemblyShape(seed, this.tuning);
      const group = new THREE.Group();
      const meshes: THREE.Mesh[] = [];
      for (const part of shape.parts) {
        const mesh = assemblyPartMesh(seed, part, ACCENT);
        mesh.userData.partIndex = part.index;
        meshes[part.index] = mesh;
        group.add(mesh);
      }
      group.position.set(
        ((i % GRID_COLUMNS) - (cols - 1) / 2) * this.spacing,
        (((rows - 1) / 2) - Math.floor(i / GRID_COLUMNS)) * this.spacing, 0,
      );
      group.quaternion.setFromEuler(new THREE.Euler(seed * 0.7, seed * 1.3, seed * 0.4));
      this.scene.add(group);
      this.individuals.push({
        seed, shape, group, meshes, combat: new AssemblyCombatState(shape),
        spinAxis: new THREE.Vector3(Math.sin(seed), Math.cos(seed * 1.7), Math.sin(seed * 2.3)).normalize(),
      });
    }
    this.selected = Math.min(this.selected, Math.max(0, this.count - 1));
    this.publishReadout();
  }

  private disposeGroup(object: THREE.Object3D): void {
    object.removeFromParent();
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    });
  }

  private frame(time: number): void {
    const dt = Math.min(0.05, (time - (this.lastTime ?? time)) / 1000);
    this.lastTime = time;
    for (const individual of this.individuals) {
      individual.group.rotateOnWorldAxis(individual.spinAxis, TUMBLE_RATE * dt);
    }
    this.debris = this.debris.filter((piece) => {
      piece.age += dt;
      if (piece.age > DEBRIS_LIFETIME) {
        this.disposeGroup(piece.mesh);
        return false;
      }
      piece.mesh.position.addScaledVector(piece.velocity, dt);
      piece.mesh.rotateOnWorldAxis(piece.spinAxis, DEBRIS_SPIN * dt);
      return true;
    });
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private lastTime: number | null = null;

  // 動かさずに離したときだけ、選択か試射として扱う(ドラッグは視点の回転)。
  private onPointerUp(event: PointerEvent): void {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (down === null || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
    const rect = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    ), this.camera);
    const hit = this.raycaster.intersectObjects(
      this.individuals.flatMap((individual) => individual.meshes.filter((mesh) => mesh.visible)), false,
    )[0];
    if (hit === undefined) return;
    const index = this.individuals.findIndex((individual) => individual.meshes.includes(hit.object as THREE.Mesh));
    if (this.mode === 'look' || index !== this.selected) {
      this.select(index);
      if (this.mode === 'look') return;
    }
    this.shoot(index, hit.object as THREE.Mesh);
  }

  // 命中した部品へ damage を入れ、尽きたら部品を畳んで破片として飛ばす。
  private shoot(index: number, mesh: THREE.Mesh): void {
    const individual = this.individuals[index]!;
    const partIndex = mesh.userData.partIndex as number;
    const broken = individual.combat.applyBulletDamage(this.damage, partIndex);
    if (broken !== null) this.launch(individual, broken);
    if (individual.combat.destroyed) {
      for (const part of individual.shape.parts) {
        if (individual.combat.partAlive(part.index) && individual.meshes[part.index]!.visible) {
          this.launch(individual, part.index);
        }
      }
    }
    this.publishReadout();
  }

  // 部品 index を、敵の姿勢と回転を引き継いで飛ぶ破片にする。
  private launch(individual: Individual, index: number): void {
    const mesh = individual.meshes[index]!;
    if (!mesh.visible) return;
    mesh.visible = false;
    const detached = detachPart(individual.shape.parts[index]!);
    const piece = assemblyPartMesh(individual.seed, detached.part, ACCENT);
    const center = new THREE.Vector3(detached.center.x, detached.center.y, detached.center.z);
    piece.quaternion.copy(individual.group.quaternion);
    piece.position.copy(center.applyQuaternion(individual.group.quaternion).add(individual.group.position));
    this.scene.add(piece);
    const outward = piece.position.clone().sub(individual.group.position).normalize();
    this.debris.push({
      mesh: piece,
      velocity: outward.multiplyScalar(DEBRIS_SPEED).add(new THREE.Vector3(
        Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5,
      ).multiplyScalar(DEBRIS_SPEED * 0.5)),
      spinAxis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      age: 0,
    });
  }

  private publishReadout(): void {
    const individual = this.individuals[this.selected];
    if (individual === undefined) {
      this.onReadout(null);
      return;
    }
    const { combat, shape } = individual;
    this.onReadout({
      seed: individual.seed,
      parts: shape.parts.length,
      outerRadius: shape.outerRadius,
      integrity: combat.integrity,
      maxIntegrity: combat.maxIntegrity,
      emitterAlive: combat.emitterAlive,
      destroyed: combat.destroyed,
      lost: shape.parts.filter((part) => !combat.partAlive(part.index)).length,
      inertia: shape.inertia,
    });
  }
}

// 1 部品の HP(試射の目安に画面へ出す)。
export const PART_HP = ASSEMBLY_PART_HP;
