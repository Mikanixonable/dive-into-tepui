// 再使用可能な一段ブースターの描画モデル。
//
// 座標系は機体の長手方向をローカル Z 軸とする。機首(前端)が +Z、ノズル
// (船尾)が -Z で、前端カプラーのおおよその面を z=0 に置く。この規約を
// 固定しておくと、複数段を親子付け/分離するときに段ごとの位置合わせを
// 特別扱いせずに済む。
import * as THREE from 'three/webgpu';
import { Billboard } from './billboard';
import { markLitOpaque } from './pipeline/lit-layer';
import { SchematicThrustCone } from './schematic-thrust-cone';
import type { RenderStyle } from './render-style';

/** 一段の外形寸法。すべて描画単位(ゲーム内の m)で、前端から船尾へは負 Z。 */
export const BOOSTER_STAGE_DIMENSIONS = Object.freeze({
  frontZ: 0.08,
  aftZ: -7.92,
  length: 8.0,
  tankFrontZ: -0.34,
  tankAftZ: -5.72,
  tankLength: 5.38,
  tankRadius: 1.26,
  frontCouplerZ: 0,
  aftDecouplerZ: -5.86,
  nozzleExitZ: -7.78,
  maximumRadius: 1.58,
});

/** 呼び出し側で寸法を参照しやすいようにした型。 */
export type BoosterStageDimensions = typeof BOOSTER_STAGE_DIMENSIONS;

export const BOOSTER_PLUME_CORE_COLOR = 0xaee6ff;
export const BOOSTER_PLUME_OUTER_COLOR = 0x4f9fff;
export const BOOSTER_PLUME_CORE_OFFSET = 0.55;
export const BOOSTER_PLUME_OUTER_OFFSET = 1.35;
export const BOOSTER_PLUME_CORE_SIZE = 0.95;
export const BOOSTER_PLUME_OUTER_SIZE = 2.2;

// 段間接続部。カバーはノズルの外周を6枚のパネルで囲み、次段の前端を
// 段間の隙間から見せずに一続きのブースターとして読めるようにする。
export const BOOSTER_INTERSTAGE_COVER_SEGMENTS = 6;
export const BOOSTER_INTERSTAGE_COVER_Z = -7.02;
export const BOOSTER_INTERSTAGE_COVER_LENGTH = 1.66;
export const BOOSTER_INTERSTAGE_COVER_RADIUS = 1.43;
export const BOOSTER_INTERSTAGE_COVER_PANEL_RADIAL = 0.18;
export const BOOSTER_INTERSTAGE_COVER_PANEL_TANGENTIAL = 0.72;
export const BOOSTER_INTERSTAGE_BOLT_Z = -7.78;

export interface BoosterStageOptions {
  /** タンク外皮の色。 */
  readonly tankColor?: THREE.ColorRepresentation;
  /** 金属部品の色。 */
  readonly metalColor?: THREE.ColorRepresentation;
  /** ノズルの色。 */
  readonly nozzleColor?: THREE.ColorRepresentation;
  /** 段間カバー。分離後の単独段では切り離されたものとして省略する。 */
  readonly interstageCover?: boolean;
}

type OwnedMaterial = THREE.Material;

/**
 * 生成した geometry/material の所有権を一段ごとに保持する Object3D。
 *
 * 毎回新しい資源を生成し、dispose は idempotent にしている。従って、同じ
 * ブースターを親から外して独立ルートへ移しても所有権は変わらず、複数段を
 * 並べた場合も段同士で共有資源を二重解放しない。Object3D.clone(true) は
 * THREE の仕様上資源を共有するため、独立した段が必要なら buildBoosterStage
 * をもう一度呼ぶこと。
 */
export class BoosterStage extends THREE.Group {
  readonly dimensions: BoosterStageDimensions = BOOSTER_STAGE_DIMENSIONS;
  readonly plumeAnchor = new THREE.Object3D();
  readonly frontCoupler = new THREE.Object3D();
  readonly aftDecoupler = new THREE.Object3D();
  readonly nozzle = new THREE.Object3D();

  private readonly ownedGeometries = new Set<THREE.BufferGeometry>();
  private readonly ownedMaterials = new Set<OwnedMaterial>();
  private disposed = false;

  constructor(options: BoosterStageOptions = {}) {
    super();
    this.name = 'booster-stage';

    const tankMaterial = new THREE.MeshStandardMaterial({
      color: options.tankColor ?? 0x6c7785,
      flatShading: true,
      roughness: 0.48,
      metalness: 0.72,
    });
    const metalMaterial = new THREE.MeshStandardMaterial({
      color: options.metalColor ?? 0xb5c0ca,
      flatShading: true,
      roughness: 0.3,
      metalness: 1,
    });
    const darkMetalMaterial = new THREE.MeshStandardMaterial({
      color: options.nozzleColor ?? 0xd9702e,
      flatShading: true,
      roughness: 0.58,
      metalness: 0.9,
    });
    const gasketMaterial = new THREE.MeshStandardMaterial({
      color: 0xa64e1e,
      flatShading: true,
      roughness: 0.7,
      metalness: 0.35,
    });
    const hotMaterial = new THREE.MeshStandardMaterial({
      color: 0x49332d,
      emissive: 0x32140e,
      emissiveIntensity: 0.5,
      flatShading: true,
      roughness: 0.65,
      metalness: 0.85,
    });

    this.ownedMaterials.add(tankMaterial);
    this.ownedMaterials.add(metalMaterial);
    this.ownedMaterials.add(darkMetalMaterial);
    this.ownedMaterials.add(gasketMaterial);
    this.ownedMaterials.add(hotMaterial);

    // 円筒タンク本体。CylinderGeometry の Y 軸を +Z へ回している。
    this.addMesh(
      new THREE.CylinderGeometry(BOOSTER_STAGE_DIMENSIONS.tankRadius, BOOSTER_STAGE_DIMENSIONS.tankRadius,
        BOOSTER_STAGE_DIMENSIONS.tankLength, 20, 2),
      tankMaterial,
      -3.03,
      'tank',
    );

    // タンクの溶接/補強バンド。軸方向の部品と異なる陰影になるため、タンクが
    // 単なる円柱ではなく圧力容器であることが側面からも読み取れる。
    for (const z of [-1.08, -3.03, -4.98]) {
      this.addAxialTorus(1.285, 0.055, z, metalMaterial, `tank-band-${z}`);
    }

    // 前端カプラーリング (z=0 付近)。中央の暗い面と外周リング、六本の
    // ボルトを分けているので、段間接続面として識別できる。
    this.frontCoupler.position.z = BOOSTER_STAGE_DIMENSIONS.frontCouplerZ;
    this.frontCoupler.name = 'front-coupler';
    this.add(this.frontCoupler);
    this.addTo(this.frontCoupler, new THREE.CylinderGeometry(1.52, 1.52, 0.28, 20), metalMaterial, 0, 'flange');
    this.addTo(this.frontCoupler, new THREE.CylinderGeometry(1.18, 1.18, 0.1, 20), gasketMaterial, 0.16, 'socket');
    this.addTorusTo(this.frontCoupler, 1.31, 0.095, 0.17, metalMaterial, 'outer-ring');
    this.addTorusTo(this.frontCoupler, 1.08, 0.06, 0.2, gasketMaterial, 'inner-ring');
    const boltGeometry = new THREE.CylinderGeometry(0.075, 0.075, 0.16, 8);
    this.ownedGeometries.add(boltGeometry);
    for (let i = 0; i < 6; i++) {
      const angle = i * Math.PI / 3;
      const bolt = new THREE.Mesh(boltGeometry, darkMetalMaterial);
      bolt.rotation.x = Math.PI / 2;
      bolt.position.set(Math.cos(angle) * 1.36, Math.sin(angle) * 1.36, 0.2);
      bolt.name = `coupler-bolt-${i}`;
      this.frontCoupler.add(bolt);
    }

    // 後端デカプラーリング (z=-5.86)。前端より太いフランジを置き、分離面を
    // タンクとノズルの境界としてはっきり見せる。
    this.aftDecoupler.position.z = BOOSTER_STAGE_DIMENSIONS.aftDecouplerZ;
    this.aftDecoupler.name = 'aft-decoupler';
    this.add(this.aftDecoupler);
    this.addTo(this.aftDecoupler, new THREE.CylinderGeometry(1.49, 1.49, 0.34, 20), metalMaterial, 0, 'flange');
    this.addTo(this.aftDecoupler, new THREE.CylinderGeometry(1.28, 1.28, 0.13, 20), gasketMaterial, -0.2, 'gasket');
    this.addTorusTo(this.aftDecoupler, 1.4, 0.1, -0.2, metalMaterial, 'outer-ring');
    this.addTorusTo(this.aftDecoupler, 1.18, 0.06, 0.02, gasketMaterial, 'inner-ring');

    // 後端ベル/円錐ノズル。ConeGeometry の底面(radius)が -Z 側(船尾)へ
    // 来るように配置するため、船尾へ向かって広がるベル形になる。
    this.nozzle.position.z = -6.0;
    this.nozzle.name = 'aft-nozzle';
    this.add(this.nozzle);
    this.addTo(this.nozzle, new THREE.CylinderGeometry(0.94, 0.94, 0.38, 18), darkMetalMaterial, 0, 'mount');
    this.addTo(this.nozzle, new THREE.ConeGeometry(0.88, 1.62, 24, 1, false), hotMaterial, -1.0, 'bell');
    this.addTo(this.nozzle, new THREE.ConeGeometry(0.67, 1.5, 24, 1, true), gasketMaterial, -1.03, 'inner-bell');
    this.addTorusTo(this.nozzle, 1.28, 0.1, -1.79, metalMaterial, 'exit-ring');
    this.addTo(this.nozzle, new THREE.CylinderGeometry(0.52, 0.52, 0.12, 18), gasketMaterial, -1.83, 'exit-aperture');
    this.plumeAnchor.position.set(0, 0, BOOSTER_STAGE_DIMENSIONS.nozzleExitZ - this.nozzle.position.z);
    this.plumeAnchor.name = 'plume-anchor';
    this.nozzle.add(this.plumeAnchor);

    // 四枚の小さな安定フィン。円筒タンクと円錐ベルの輪郭をつなぎ、後方から
    // 見たときもブースターの向きを読みやすくする。
    const finGeometry = new THREE.BoxGeometry(0.12, 0.82, 1.25);
    this.ownedGeometries.add(finGeometry);
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI / 2;
      const fin = new THREE.Mesh(finGeometry, darkMetalMaterial);
      fin.position.set(Math.cos(angle) * 1.05, Math.sin(angle) * 1.05, -6.75);
      fin.rotation.z = angle;
      fin.name = `aft-fin-${i}`;
      this.add(fin);
    }

    if (options.interstageCover !== false) this.addInterstageCover();

    // MeshStandardMaterial の全サブメッシュを太陽光プリパスへ参加させる。
    markLitOpaque(this);
  }

  private addInterstageCover(): void {
    const cover = new THREE.Group();
    cover.name = 'interstage-cover';
    for (let i = 0; i < BOOSTER_INTERSTAGE_COVER_SEGMENTS; i++) {
      const angle = (i * Math.PI * 2) / BOOSTER_INTERSTAGE_COVER_SEGMENTS;
      const panel = buildBoosterInterstageCoverPanelMesh(i);
      panel.position.set(
        Math.cos(angle) * BOOSTER_INTERSTAGE_COVER_RADIUS,
        Math.sin(angle) * BOOSTER_INTERSTAGE_COVER_RADIUS,
        BOOSTER_INTERSTAGE_COVER_Z,
      );
      panel.name = `interstage-cover-panel-${i}`;
      this.ownMesh(panel, cover);

      const bolt = buildBoosterExplosiveBoltMesh(i);
      bolt.position.set(
        Math.cos(angle) * (BOOSTER_INTERSTAGE_COVER_RADIUS + 0.08),
        Math.sin(angle) * (BOOSTER_INTERSTAGE_COVER_RADIUS + 0.08),
        BOOSTER_INTERSTAGE_BOLT_Z,
      );
      bolt.name = `interstage-explosive-bolt-${i}`;
      this.ownMesh(bolt, cover);
    }
    this.add(cover);
  }

  private ownMesh(mesh: THREE.Mesh, parent: THREE.Object3D): void {
    this.ownedGeometries.add(mesh.geometry);
    const material = mesh.material as OwnedMaterial | OwnedMaterial[];
    if (Array.isArray(material)) material.forEach((m) => this.ownedMaterials.add(m));
    else this.ownedMaterials.add(material);
    mesh.userData.boosterOwned = true;
    parent.add(mesh);
  }

  private addMesh(geometry: THREE.BufferGeometry, material: OwnedMaterial, z: number, name: string): void {
    this.ownedGeometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.z = z;
    mesh.name = name;
    mesh.userData.boosterOwned = true;
    this.add(mesh);
  }

  private addTo(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: OwnedMaterial, z: number, name: string): void {
    this.ownedGeometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.z = z;
    mesh.name = name;
    mesh.userData.boosterOwned = true;
    parent.add(mesh);
  }

  private addAxialTorus(radius: number, tube: number, z: number, material: OwnedMaterial, name: string): void {
    const geometry = new THREE.TorusGeometry(radius, tube, 8, 20);
    this.ownedGeometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.z = z;
    mesh.name = name;
    mesh.userData.boosterOwned = true;
    this.add(mesh);
  }

  private addTorusTo(parent: THREE.Object3D, radius: number, tube: number, z: number, material: OwnedMaterial, name: string): void {
    const geometry = new THREE.TorusGeometry(radius, tube, 8, 20);
    this.ownedGeometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.z = z;
    mesh.name = name;
    mesh.userData.boosterOwned = true;
    parent.add(mesh);
  }

  /** 親から外されて独立ルートになった後でも同じように安全に破棄できる。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeFromParent();
    this.frontCoupler.clear();
    this.aftDecoupler.clear();
    this.nozzle.clear();
    this.clear();
    for (const geometry of this.ownedGeometries) geometry.dispose();
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedGeometries.clear();
    this.ownedMaterials.clear();
  }
}

/** 新しい geometry/material を所有する独立した一段を生成する。 */
export function buildBoosterStage(options: BoosterStageOptions = {}): BoosterStage {
  return new BoosterStage(options);
}

/** 呼び出し側が「モデル」と呼ぶ場合にも分かりやすい別名。 */
export const buildBoosterModel = buildBoosterStage;

/** THREE.Object3D.clone(true) の資源共有を避けた独立複製。 */
export function cloneBoosterStage(options: BoosterStageOptions = {}): BoosterStage {
  return buildBoosterStage(options);
}

/** 接続中にデカプラー側面を覆うパネル。分離時は DebrisPiece として再生成する。 */
export function buildBoosterInterstageCoverPanelMesh(segment: number): THREE.Mesh {
  const angle = (segment * Math.PI * 2) / BOOSTER_INTERSTAGE_COVER_SEGMENTS;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(
      BOOSTER_INTERSTAGE_COVER_PANEL_RADIAL,
      BOOSTER_INTERSTAGE_COVER_PANEL_TANGENTIAL,
      BOOSTER_INTERSTAGE_COVER_LENGTH,
    ),
    new THREE.MeshStandardMaterial({
      color: 0x3d4b59,
      flatShading: true,
      roughness: 0.42,
      metalness: 0.82,
    }),
  );
  mesh.rotation.z = angle;
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  mesh.userData.boosterOwned = true;
  markLitOpaque(mesh);
  return mesh;
}

/** 段間を固定する爆砕ボルト。分離時は径方向へ射出する。 */
export function buildBoosterExplosiveBoltMesh(segment: number): THREE.Mesh {
  const angle = (segment * Math.PI * 2) / BOOSTER_INTERSTAGE_COVER_SEGMENTS;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.095, 0.095, 0.28, 8),
    new THREE.MeshStandardMaterial({
      color: 0xe19a3e,
      emissive: 0x6d260c,
      emissiveIntensity: 0.55,
      flatShading: true,
      roughness: 0.38,
      metalness: 0.9,
    }),
  );
  mesh.rotation.x = Math.PI / 2;
  mesh.rotation.z += angle;
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  mesh.userData.boosterOwned = true;
  markLitOpaque(mesh);
  return mesh;
}

export interface BoosterPlumeSample {
  /** ノズル出口のワールド座標。 */
  readonly position: THREE.Vector3;
  /** ノズルから船尾へ向くワールド方向。ゼロベクトルは非表示扱い。 */
  readonly direction: THREE.Vector3;
  readonly intensity?: number;
  readonly scale?: number;
  readonly visible?: boolean;
}

/**
 * 一段分の発光プルーム。音源を持たないため、共有 WorldSfx の主推力ループを
 * 複数段が奪い合わない。sound は外側の gameplay/controller が必要な段だけ
 * 選んで制御する。
 */
export class BoosterPlume {
  readonly core = new THREE.Object3D();
  readonly outer = new THREE.Object3D();
  private readonly coreBillboard = new Billboard(BOOSTER_PLUME_CORE_COLOR);
  private readonly outerBillboard = new Billboard(BOOSTER_PLUME_OUTER_COLOR);
  private readonly schematicCone = new SchematicThrustCone();
  private disposed = false;

  constructor(scene?: THREE.Scene) {
    // Billboard のメッシュを公開 Object3D の子にまとめる。匿名 Object3D を
    // 用いることで、個別段の scene への追加/削除を一回で扱える。
    this.core.name = 'booster-plume-core';
    this.outer.name = 'booster-plume-outer';
    this.core.add(this.coreBillboard.mesh);
    this.outer.add(this.outerBillboard.mesh);
    if (scene) this.addToScene(scene);
  }

  private addToScene(scene: THREE.Scene): void {
    scene.add(this.core, this.outer, this.schematicCone.mesh);
  }

  // style が模式図なら、ビルボードの代わりに輪郭抽出へ拾われるコーンを出す。
  sync(sample: BoosterPlumeSample, cameraQuaternion: THREE.Quaternion, style: RenderStyle): void {
    if (this.disposed) return;
    if (sample.visible === false || sample.direction.lengthSq() < 1e-12) {
      this.hide();
      return;
    }
    const direction = sample.direction.clone().normalize();
    const intensity = Math.max(0, sample.intensity ?? 1);
    const scale = Math.max(0, sample.scale ?? 1);

    if (style === 'schematic') {
      this.coreBillboard.hide();
      this.outerBillboard.hide();
      this.schematicCone.sync(sample.position, direction, Math.min(1, intensity), scale);
      return;
    }
    this.schematicCone.hide();

    const corePosition = sample.position.clone().addScaledVector(direction, BOOSTER_PLUME_CORE_OFFSET);
    const outerPosition = sample.position.clone().addScaledVector(direction, BOOSTER_PLUME_OUTER_OFFSET);
    this.coreBillboard.sync(corePosition, BOOSTER_PLUME_CORE_SIZE * scale, intensity, cameraQuaternion);
    this.outerBillboard.sync(outerPosition, BOOSTER_PLUME_OUTER_SIZE * scale, intensity * 0.38, cameraQuaternion);
  }

  hide(): void {
    this.coreBillboard.hide();
    this.outerBillboard.hide();
    this.schematicCone.hide();
  }

  dispose(scene?: THREE.Scene): void {
    if (this.disposed) return;
    this.disposed = true;
    if (scene) scene.remove(this.core, this.outer, this.schematicCone.mesh);
    // scene 引数が生成時の scene と違っても、現在の親から必ず外す。
    this.core.removeFromParent();
    this.outer.removeFromParent();
    this.schematicCone.dispose();
    this.coreBillboard.dispose();
    this.outerBillboard.dispose();
    this.core.clear();
    this.outer.clear();
  }
}

/** 複数ブースターのプルームを一回の同期で更新する小さな描画専用管理クラス。 */
export class BoosterPlumeSet {
  private readonly plumes: BoosterPlume[] = [];
  private disposed = false;

  constructor(private readonly scene?: THREE.Scene) {}

  sync(samples: readonly BoosterPlumeSample[], cameraQuaternion: THREE.Quaternion, style: RenderStyle): void {
    if (this.disposed) return;
    while (this.plumes.length < samples.length) {
      const plume = new BoosterPlume(this.scene);
      this.plumes.push(plume);
    }
    for (let i = 0; i < this.plumes.length; i++) {
      const sample = samples[i];
      if (sample) this.plumes[i]!.sync(sample, cameraQuaternion, style);
      else this.plumes[i]!.hide();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const plume of this.plumes) plume.dispose(this.scene);
    this.plumes.length = 0;
  }
}
