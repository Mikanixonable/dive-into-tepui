import * as THREE from 'three/webgpu';
import { qInvert, qRotate, type Quat } from '../../physics/attitude';
import { add, sub, type Vec3, v3 } from '../../physics/vec3';
import type { ProteinAssetDefinition, ProteinHudSnapshot, ProteinSaveData } from './protein-schema';
import { ProteinCombatState } from './protein-combat-state';
import { ProteinBrownianSampler, proteinBrownianSeedFor } from './protein-brownian-motion';

const RUNTIME_VISUAL = 'protein-runtime-visual';
// タンパク質のブラウン振動は振幅を保ったまま、時間方向だけ現状の 1/4 で進める。
const PROTEIN_BROWNIAN_TIME_SCALE = 1 / 4;

interface ProteinBondVisual {
  readonly line: THREE.Line;
  readonly fromSiteId: string;
  readonly toSiteId: string;
}

export class ProteinRuntime {
  readonly combat: ProteinCombatState;
  private readonly root: THREE.Object3D;
  private readonly siteMeshes = new Map<string, THREE.Mesh>();
  private readonly modificationMeshes = new Map<string, THREE.Mesh>();
  private readonly baseSitePositions = new Map<string, THREE.Vector3>();
  private readonly baseModificationPositions = new Map<string, THREE.Vector3>();
  private readonly siteComponentIds = new Map<string, string | undefined>();
  private readonly modificationComponentIds = new Map<string, string | undefined>();
  private readonly baseComponentPositions = new Map<THREE.Object3D, THREE.Vector3>();
  private readonly baseComponentRotations = new Map<THREE.Object3D, THREE.Quaternion>();
  private readonly componentMotionTranslations = new Map<string, Float32Array>();
  private readonly childMotionTranslations = new Map<THREE.Object3D, Float32Array | undefined>();
  private readonly childComponentIndices = new Map<THREE.Object3D, number>();
  private readonly componentVisuals: THREE.Object3D[] = [];
  private readonly bondVisuals: ProteinBondVisual[] = [];
  private readonly bondMaterial: THREE.LineBasicMaterial;
  private readonly motionSampler: ProteinBrownianSampler;
  private readonly motionCoefficients: Float64Array;

  constructor(root: THREE.Object3D, asset: ProteinAssetDefinition, saved?: ProteinSaveData, legacyHealth?: number, seedKey = asset.id) {
    this.root = root;
    this.combat = new ProteinCombatState(asset, saved, legacyHealth);
    this.motionSampler = new ProteinBrownianSampler(asset.motion.modes, asset.motion.sampleHz, proteinBrownianSeedFor(seedKey));
    this.motionCoefficients = new Float64Array(asset.motion.modes.length);
    this.bondMaterial = new THREE.LineBasicMaterial({ color: 0x60d9ff, transparent: true, opacity: 0.42 });
    this.rebuildVisuals();
  }

  get asset(): ProteinAssetDefinition { return this.combat.asset; }
  get hudSnapshot(): ProteinHudSnapshot { return this.combat.hudSnapshot(); }

  clearVisuals(): void {
    // A rebuild can happen after the last visual update. Restore source transforms before
    // discarding their caches, otherwise a later rebuild would capture a displaced base pose.
    for (const [child, base] of this.baseComponentPositions) child.position.copy(base);
    for (const [child, baseRotation] of this.baseComponentRotations) child.quaternion.copy(baseRotation);
    for (const child of [...this.root.children]) {
      if (child.userData[RUNTIME_VISUAL] !== true) continue;
      child.traverse((nested) => {
        const mesh = nested as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
          else mesh.material.dispose();
        }
        const line = nested as THREE.Line;
        if (line.isLine) line.geometry.dispose();
      });
      this.root.remove(child);
    }
    this.siteMeshes.clear();
    this.modificationMeshes.clear();
    this.baseSitePositions.clear();
    this.baseModificationPositions.clear();
    this.siteComponentIds.clear();
    this.modificationComponentIds.clear();
    this.baseComponentPositions.clear();
    this.baseComponentRotations.clear();
    this.componentMotionTranslations.clear();
    this.childMotionTranslations.clear();
    this.childComponentIndices.clear();
    this.componentVisuals.length = 0;
    this.bondVisuals.length = 0;
  }

  rebuildVisuals(): void {
    this.clearVisuals();
    const scale = this.asset.coordinateScale;
    for (const component of this.asset.components) {
      const table = this.componentTranslationTable(component.id);
      this.componentMotionTranslations.set(component.id, table);
      for (const chain of component.chains) this.componentMotionTranslations.set(chain, table);
    }
    this.cacheComponentVisuals();
    for (const site of this.asset.sites) {
      const [x, y, z] = site.position;
      const position = new THREE.Vector3(x * scale, y * scale, z * scale);
      const material = new THREE.MeshStandardMaterial({
        color: site.type === 'active' ? 0x55eaff : site.type === 'interface' ? 0x887cff : 0xffbb55,
        emissive: site.type === 'active' ? 0x007caa : 0x25104c,
        emissiveIntensity: 0.55,
        roughness: 0.22,
        metalness: 0.5,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      });
      // A small triangular marker is deliberately separate from the structure. Its size and
      // opacity encode the remaining HP while the marker itself keeps the region targetable.
      const mesh = new THREE.Mesh(new THREE.ConeGeometry(Math.max(0.36, site.radius * scale * 0.18), 0.16, 3), material);
      mesh.position.copy(position);
      mesh.renderOrder = 4;
      mesh.userData[RUNTIME_VISUAL] = true;
      mesh.userData.proteinSiteId = site.id;
      this.root.add(mesh);
      this.siteMeshes.set(site.id, mesh);
      this.baseSitePositions.set(site.id, position);
      this.siteComponentIds.set(site.id, site.componentId);
    }
    for (const slot of this.asset.modificationSlots) {
      const [x, y, z] = slot.position;
      const material = new THREE.MeshStandardMaterial({
        color: 0xffd84a, emissive: 0xff6a00, emissiveIntensity: 1.1,
        roughness: 0.18, metalness: 0.7,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.75, 12, 8), material);
      mesh.position.set(x * scale, y * scale, z * scale);
      mesh.userData[RUNTIME_VISUAL] = true;
      this.root.add(mesh);
      this.modificationMeshes.set(slot.id, mesh);
      this.baseModificationPositions.set(slot.id, mesh.position.clone());
      this.modificationComponentIds.set(slot.id, slot.componentId);
    }
    for (const bond of this.asset.bonds) {
      const from = this.combat.site(bond.from);
      const to = this.combat.site(bond.to);
      if (!from || !to) continue;
      const [ax, ay, az] = from.position;
      const [ix, iy, iz] = to.position;
      const fromBase = new THREE.Vector3(ax * scale, ay * scale, az * scale);
      const toBase = new THREE.Vector3(ix * scale, iy * scale, iz * scale);
      const geometry = new THREE.BufferGeometry().setFromPoints([fromBase, toBase]);
      const line = new THREE.Line(geometry, this.bondMaterial);
      line.userData[RUNTIME_VISUAL] = true;
      this.root.add(line);
      this.bondVisuals.push({ line, fromSiteId: bond.from, toSiteId: bond.to });
    }
  }

  updateVisual(simTime: number): void {
    this.motionSampler.sampleAt(simTime * PROTEIN_BROWNIAN_TIME_SCALE, this.motionCoefficients);
    const visualScale = this.asset.coordinateScale * this.asset.motion.visualGain;
    const state = this.combat;
    // Motion here is capped visual deformation; the physics root and collision positions remain authoritative.
    for (const child of this.componentVisuals) {
      const base = this.baseComponentPositions.get(child);
      if (!base) continue;
      const baseRotation = this.baseComponentRotations.get(child);
      if (!baseRotation) continue;
      const translationTable = this.childMotionTranslations.get(child);
      let x = 0;
      let y = 0;
      let z = 0;
      if (translationTable) {
        for (let modeIndex = 0; modeIndex < this.motionCoefficients.length; modeIndex += 1) {
          const offset = modeIndex * 3;
          const coefficient = this.motionCoefficients[modeIndex]!;
          x += coefficient * translationTable[offset]!;
          y += coefficient * translationTable[offset + 1]!;
          z += coefficient * translationTable[offset + 2]!;
        }
      }
      const dissociation = state.phase === 'dissociated' ? 0.28 : state.phase === 'exposed' ? 0.06 : 0;
      child.position.copy(base);
      // Keep the physics pose on root intact. Component-local offsets provide the visual
      // molecular motion and dissociation without fighting Enemy.sync()'s quaternion.
      const componentIndex = this.childComponentIndices.get(child) ?? 0;
      child.position.x += x * visualScale + dissociation * ((componentIndex % 3) - 1);
      child.position.y += y * visualScale + dissociation * ((componentIndex % 2) ? 0.7 : -0.7);
      child.position.z += z * visualScale + dissociation * ((componentIndex % 4) - 1.5);
      child.quaternion.copy(baseRotation);
    }
    for (const site of this.asset.sites) {
      const mesh = this.siteMeshes.get(site.id);
      if (!mesh) continue;
      const base = this.baseSitePositions.get(site.id);
      const siteState = state.siteState(site.id);
      if (!base || !siteState) continue;
      this.setModalPosition(mesh, base, this.componentMotionTranslations.get(this.siteComponentIds.get(site.id) ?? ''), visualScale);
      mesh.visible = true;
      const material = mesh.material as THREE.MeshStandardMaterial;
      const ratio = siteState.maxHp > 0 ? Math.max(0, Math.min(1, siteState.hp / siteState.maxHp)) : 0;
      material.opacity = siteState.disabled ? 0.18 : 0.32 + ratio * 0.68;
      material.emissiveIntensity = (siteState.disabled ? 0.05 : 0.25 + ratio * 0.5) + (state.phase === 'critical' ? 0.35 : 0);
      mesh.scale.setScalar(0.55 + ratio * 0.45);
    }
    for (const slot of this.asset.modificationSlots) {
      const mesh = this.modificationMeshes.get(slot.id);
      if (!mesh) continue;
      const base = this.baseModificationPositions.get(slot.id);
      if (base) this.setModalPosition(mesh, base, this.componentMotionTranslations.get(this.modificationComponentIds.get(slot.id) ?? ''), visualScale);
      const active = state.modificationState(slot.id) !== 'empty';
      mesh.visible = active;
      mesh.scale.setScalar(active ? 1 + 0.12 * Math.sin(simTime * 2.4) : 0.001);
    }
    for (const bond of this.bondVisuals) {
      const from = this.siteMeshes.get(bond.fromSiteId);
      const to = this.siteMeshes.get(bond.toSiteId);
      if (!from || !to) continue;
      const positions = bond.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      positions.setXYZ(0, from.position.x, from.position.y, from.position.z);
      positions.setXYZ(1, to.position.x, to.position.y, to.position.z);
      positions.needsUpdate = true;
    }
    this.bondMaterial.opacity = state.phase === 'intact' ? 0.42 : state.phase === 'critical' ? 0.12 : 0.68;
  }

  private componentTranslationTable(componentId: string): Float32Array {
    const table = new Float32Array(this.motionCoefficients.length * 3);
    for (let modeIndex = 0; modeIndex < this.asset.motion.modes.length; modeIndex += 1) {
      const mode = this.asset.motion.modes[modeIndex]!;
      for (const component of mode.components) {
        if (component.componentId !== componentId) continue;
        const offset = modeIndex * 3;
        table[offset] = component.translation[0];
        table[offset + 1] = component.translation[1];
        table[offset + 2] = component.translation[2];
        break;
      }
    }
    return table;
  }

  private cacheComponentVisuals(): void {
    this.root.traverse((child) => {
      if (!child.userData.proteinComponent) return;
      this.baseComponentPositions.set(child, child.position.clone());
      this.baseComponentRotations.set(child, child.quaternion.clone());
      const chain = String(child.userData.proteinComponent);
      const componentId = this.asset.components.find((component) => component.chains.includes(chain))?.id;
      this.childMotionTranslations.set(child, componentId ? this.componentMotionTranslations.get(componentId) : undefined);
      this.childComponentIndices.set(child, Math.max(0, chain.charCodeAt(0) - 65));
      this.componentVisuals.push(child);
    });
  }

  private setModalPosition(mesh: THREE.Object3D, base: THREE.Vector3, translationTable: Float32Array | undefined, visualScale: number): void {
    let x = 0;
    let y = 0;
    let z = 0;
    if (translationTable) {
      for (let modeIndex = 0; modeIndex < this.motionCoefficients.length; modeIndex += 1) {
        const offset = modeIndex * 3;
        const coefficient = this.motionCoefficients[modeIndex]!;
        x += coefficient * translationTable[offset]!;
        y += coefficient * translationTable[offset + 1]!;
        z += coefficient * translationTable[offset + 2]!;
      }
    }
    mesh.position.set(base.x + x * visualScale, base.y + y * visualScale, base.z + z * visualScale);
  }

  activeSiteWorldPosition(origin: Vec3, attitude: Quat): Vec3 {
    return this.siteWorldPosition(this.combat.activeSite, origin, attitude);
  }

  nextAttackSiteWorldPosition(origin: Vec3, attitude: Quat): Vec3 {
    return this.siteWorldPosition(this.combat.nextAttackSite(), origin, attitude);
  }

  private siteWorldPosition(site: ProteinAssetDefinition['sites'][number] | null, origin: Vec3, attitude: Quat): Vec3 {
    if (!site) return origin;
    const [x, y, z] = site.position;
    const rootScale = this.root.scale.x;
    const local = v3(x * this.asset.coordinateScale * rootScale, y * this.asset.coordinateScale * rootScale, z * this.asset.coordinateScale * rootScale);
    return add(origin, qRotate(attitude, local));
  }

  localImpactPoint(worldPoint: Vec3, origin: Vec3, attitude: Quat): Vec3 {
    const rootScale = this.root.scale.x;
    const oriented = qRotate(qInvert(attitude), sub(worldPoint, origin));
    return v3(oriented.x / rootScale, oriented.y / rootScale, oriented.z / rootScale);
  }

  dispose(): void {
    this.clearVisuals();
    this.bondMaterial.dispose();
  }
}
