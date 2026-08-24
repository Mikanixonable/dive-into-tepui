import * as THREE from 'three/webgpu';
import { qInvert, qRotate, type Quat } from '../../physics/attitude';
import { add, sub, type Vec3, v3 } from '../../physics/vec3';
import type { ProteinAssetDefinition, ProteinHudSnapshot, ProteinSaveData } from './protein-schema';
import { ProteinCombatState } from './protein-combat-state';
import { proteinMotionAt, proteinMotionSeedFor } from './protein-motion';

const RUNTIME_VISUAL = 'protein-runtime-visual';

export class ProteinRuntime {
  readonly combat: ProteinCombatState;
  private readonly root: THREE.Object3D;
  private readonly siteMeshes = new Map<string, THREE.Mesh>();
  private readonly modificationMeshes = new Map<string, THREE.Mesh>();
  private readonly baseSitePositions = new Map<string, THREE.Vector3>();
  private readonly baseComponentPositions = new Map<THREE.Object3D, THREE.Vector3>();
  private readonly baseComponentRotations = new Map<THREE.Object3D, THREE.Quaternion>();
  private readonly bondMaterial: THREE.LineBasicMaterial;
  private readonly motionSeed: number;

  constructor(root: THREE.Object3D, asset: ProteinAssetDefinition, saved?: ProteinSaveData, legacyHealth?: number, seedKey = asset.id) {
    this.root = root;
    this.combat = new ProteinCombatState(asset, saved, legacyHealth);
    this.motionSeed = proteinMotionSeedFor(seedKey);
    this.bondMaterial = new THREE.LineBasicMaterial({ color: 0x60d9ff, transparent: true, opacity: 0.42 });
    this.rebuildVisuals();
  }

  get asset(): ProteinAssetDefinition { return this.combat.asset; }
  get hudSnapshot(): ProteinHudSnapshot { return this.combat.hudSnapshot(); }

  clearVisuals(): void {
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
    this.baseComponentPositions.clear();
    this.baseComponentRotations.clear();
  }

  rebuildVisuals(): void {
    this.clearVisuals();
    const scale = this.asset.coordinateScale;
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
    }
    const active = this.combat.site('primary-active-site');
    const iface = this.combat.site('complex-interface');
    if (active && iface) {
      const [ax, ay, az] = active.position;
      const [ix, iy, iz] = iface.position;
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(ax * scale, ay * scale, az * scale),
        new THREE.Vector3(ix * scale, iy * scale, iz * scale),
      ]);
      const line = new THREE.Line(geometry, this.bondMaterial);
      line.userData[RUNTIME_VISUAL] = true;
      this.root.add(line);
    }
  }

  updateVisual(simTime: number): void {
    const motion = proteinMotionAt(simTime, this.asset.motion, this.motionSeed + 1.3);
    const state = this.combat;
    this.root.traverse((child) => {
      if (!child.userData.proteinComponent) return;
      const base = this.baseComponentPositions.get(child) ?? child.position.clone();
      this.baseComponentPositions.set(child, base);
      const baseRotation = this.baseComponentRotations.get(child) ?? child.quaternion.clone();
      this.baseComponentRotations.set(child, baseRotation);
      const component = String(child.userData.proteinComponent);
      const componentIndex = Math.max(0, component.charCodeAt(0) - 65);
      const dissociation = state.phase === 'dissociated' ? 0.28 : state.phase === 'exposed' ? 0.06 : 0;
      child.position.copy(base);
      // Keep the physics pose on root intact. Component-local offsets provide the visual
      // molecular motion and dissociation without fighting Enemy.sync()'s quaternion.
      child.position.x += motion.x * 0.08 + dissociation * ((componentIndex % 3) - 1);
      child.position.y += motion.y * 0.08 + dissociation * ((componentIndex % 2) ? 0.7 : -0.7);
      child.position.z += motion.z * 0.08 + dissociation * ((componentIndex % 4) - 1.5);
      child.quaternion.copy(baseRotation);
      child.rotateZ(motion.roll * (1 + (componentIndex % 3) * 0.15));
    });
    for (const site of this.asset.sites) {
      const mesh = this.siteMeshes.get(site.id);
      if (!mesh) continue;
      const base = this.baseSitePositions.get(site.id);
      const siteState = state.siteState(site.id);
      if (!base || !siteState) continue;
      mesh.position.copy(base).add(new THREE.Vector3(motion.x * 0.5, motion.y * 0.5, motion.z * 0.5));
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
      const active = state.modificationState(slot.id) !== 'empty';
      mesh.visible = active;
      mesh.scale.setScalar(active ? 1 + 0.12 * Math.sin(simTime * 2.4) : 0.001);
    }
    this.bondMaterial.opacity = state.phase === 'intact' ? 0.42 : state.phase === 'critical' ? 0.12 : 0.68;
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
