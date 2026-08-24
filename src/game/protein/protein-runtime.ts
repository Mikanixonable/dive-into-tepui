import * as THREE from 'three/webgpu';
import type { Quat } from '../../physics/attitude';
import type { Vec3 } from '../../physics/vec3';
import type {
  ProteinAssetDefinition,
  ProteinHudSnapshot,
  ProteinMotionAsset,
  ProteinPhase,
  ProteinSaveData,
  ProteinSiteDefinition,
} from './protein-schema';
import { ProteinCombatState } from './protein-combat-state';
import {
  proteinAnchorResidues,
  proteinLocalImpactPoint,
  proteinSiteWorldPosition,
  setProteinAnchorPosition,
} from './protein-anchors';
import {
  ProteinMotionController,
  proteinMotionLodForProjectedSize,
  type ProteinMotionLod,
} from './protein-motion-controller';
import {
  createProteinMotionBinding,
  disposeProteinMotionBinding,
  updateProteinMotionBinding,
  type ProteinMotionBinding,
} from '../../render/protein-motion-material';

const RUNTIME_VISUAL = 'protein-runtime-visual';

interface ProteinBondVisual {
  readonly line: THREE.Line;
  readonly fromSiteId: string;
  readonly toSiteId: string;
}

/** Owns gameplay state and display-only ANM/OU deformation for one enemy. */
export class ProteinRuntime {
  readonly combat: ProteinCombatState;
  readonly motion: ProteinMotionAsset;
  readonly controller: ProteinMotionController;
  readonly motionBinding: ProteinMotionBinding;
  private readonly root: THREE.Object3D;
  private readonly siteMeshes = new Map<string, THREE.Mesh>();
  private readonly modificationMeshes = new Map<string, THREE.Mesh>();
  private readonly baseSitePositions = new Map<string, THREE.Vector3>();
  private readonly baseModificationPositions = new Map<string, THREE.Vector3>();
  private readonly siteResidueGroups = new Map<string, readonly number[]>();
  private readonly modificationResidueGroups = new Map<string, readonly number[]>();
  private readonly bondVisuals: ProteinBondVisual[] = [];
  private readonly bondMaterial: THREE.LineBasicMaterial;
  private currentLod: ProteinMotionLod = 'near';
  private uploadedLod: ProteinMotionLod | null = null;
  private uploadedSampleTime = Number.NaN;
  private uploadedPhase: ProteinPhase | null = null;
  private lastCpuMs = 0;
  private lastUploadBytes = 0;

  constructor(
    root: THREE.Object3D,
    asset: ProteinAssetDefinition,
    motion: ProteinMotionAsset,
    saved?: ProteinSaveData,
    legacyHealth?: number,
    seedKey = asset.id,
    motionBinding?: ProteinMotionBinding,
  ) {
    this.root = root;
    this.combat = new ProteinCombatState(asset, saved, legacyHealth);
    this.motion = motion;
    this.controller = new ProteinMotionController(motion, seedKey);
    this.motionBinding = motionBinding ?? createProteinMotionBinding(motion.residueCount);
    if (this.motionBinding.residueCount !== motion.residueCount) {
      throw new RangeError('Protein motion binding and asset residue counts must match');
    }
    this.bondMaterial = new THREE.LineBasicMaterial({ color: 0x60d9ff, transparent: true, opacity: 0.42 });
    this.rebuildVisuals();
  }

  get asset(): ProteinAssetDefinition { return this.combat.asset; }
  get hudSnapshot(): ProteinHudSnapshot { return this.combat.hudSnapshot(); }
  get lod(): ProteinMotionLod { return this.currentLod; }
  get cpuMs(): number { return this.lastCpuMs; }
  get uploadBytes(): number { return this.lastUploadBytes; }

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
    this.baseModificationPositions.clear();
    this.siteResidueGroups.clear();
    this.modificationResidueGroups.clear();
    this.bondVisuals.length = 0;
  }

  rebuildVisuals(): void {
    this.clearVisuals();
    const scale = this.asset.coordinateScale;
    for (let index = 0; index < this.asset.sites.length; index += 1) {
      const site = this.asset.sites[index]!;
      const [x, y, z] = site.position;
      const position = new THREE.Vector3(x * scale, y * scale, z * scale);
      const material = new THREE.MeshStandardMaterial({
        color: site.type === 'active' ? 0x55eaff : site.type === 'interface' ? 0x887cff : 0xffbb55,
        emissive: site.type === 'active' ? 0x007caa : 0x25104c,
        emissiveIntensity: 0.55, roughness: 0.22, metalness: 0.5,
        transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.ConeGeometry(Math.max(0.36, site.radius * scale * 0.18), 0.16, 3), material);
      mesh.position.copy(position);
      mesh.renderOrder = 4;
      mesh.userData[RUNTIME_VISUAL] = true;
      mesh.userData.proteinSiteId = site.id;
      this.root.add(mesh);
      this.siteMeshes.set(site.id, mesh);
      this.baseSitePositions.set(site.id, position);
      this.siteResidueGroups.set(site.id, proteinAnchorResidues(site, index, this.motion, this.motion.bindings.siteResidues));
    }
    for (let index = 0; index < this.asset.modificationSlots.length; index += 1) {
      const slot = this.asset.modificationSlots[index]!;
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
      this.modificationResidueGroups.set(slot.id, proteinAnchorResidues(slot, index, this.motion, this.motion.bindings.modificationResidues));
    }
    for (const bond of this.asset.bonds) {
      const from = this.combat.site(bond.from);
      const to = this.combat.site(bond.to);
      if (!from || !to) continue;
      const [ax, ay, az] = from.position;
      const [ix, iy, iz] = to.position;
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(ax * scale, ay * scale, az * scale),
        new THREE.Vector3(ix * scale, iy * scale, iz * scale),
      ]);
      const line = new THREE.Line(geometry, this.bondMaterial);
      line.userData[RUNTIME_VISUAL] = true;
      this.root.add(line);
      this.bondVisuals.push({ line, fromSiteId: bond.from, toSiteId: bond.to });
    }
  }

  /** Update deterministic OU coefficients and upload the shared GPU residue buffer. */
  updateVisual(displayTime: number, projectedDiameterPx = Number.POSITIVE_INFINITY): void {
    const cpuStart = performance.now();
    this.currentLod = proteinMotionLodForProjectedSize(projectedDiameterPx, this.currentLod);
    const offsets = this.controller.update(displayTime, this.currentLod, this.combat.phase);
    if (this.uploadedLod !== this.currentLod || this.uploadedSampleTime !== this.controller.sampleTime
      || this.uploadedPhase !== this.combat.phase) {
      updateProteinMotionBinding(this.motionBinding, offsets);
      this.uploadedLod = this.currentLod;
      this.uploadedSampleTime = this.controller.sampleTime;
      this.uploadedPhase = this.combat.phase;
      this.lastUploadBytes = offsets.byteLength;
    } else {
      this.lastUploadBytes = 0;
    }
    this.lastCpuMs = performance.now() - cpuStart;
    const scale = this.asset.coordinateScale;
    const state = this.combat;
    for (const site of this.asset.sites) {
      const mesh = this.siteMeshes.get(site.id);
      const base = this.baseSitePositions.get(site.id);
      const siteState = state.siteState(site.id);
      if (!mesh || !base || !siteState) continue;
      setProteinAnchorPosition(mesh, base, this.siteResidueGroups.get(site.id) ?? [], this.controller.residueOffsets, this.motion.residueCount, scale);
      mesh.visible = true;
      const material = mesh.material as THREE.MeshStandardMaterial;
      const ratio = siteState.maxHp > 0 ? Math.max(0, Math.min(1, siteState.hp / siteState.maxHp)) : 0;
      material.opacity = siteState.disabled ? 0.18 : 0.32 + ratio * 0.68;
      material.emissiveIntensity = (siteState.disabled ? 0.05 : 0.25 + ratio * 0.5) + (state.phase === 'critical' ? 0.35 : 0);
      mesh.scale.setScalar(0.55 + ratio * 0.45);
    }
    for (const slot of this.asset.modificationSlots) {
      const mesh = this.modificationMeshes.get(slot.id);
      const base = this.baseModificationPositions.get(slot.id);
      if (!mesh || !base) continue;
      setProteinAnchorPosition(mesh, base, this.modificationResidueGroups.get(slot.id) ?? [], this.controller.residueOffsets, this.motion.residueCount, scale);
      const active = state.modificationState(slot.id) !== 'empty';
      mesh.visible = active;
      mesh.scale.setScalar(active ? 1 + 0.12 * Math.sin(displayTime * 2.4) : 0.001);
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

  activeSiteWorldPosition(origin: Vec3, attitude: Quat): Vec3 {
    return this.siteWorldPosition(this.combat.activeSite, origin, attitude);
  }

  nextAttackSiteWorldPosition(origin: Vec3, attitude: Quat): Vec3 {
    return this.siteWorldPosition(this.combat.nextAttackSite(), origin, attitude);
  }

  private siteWorldPosition(site: ProteinSiteDefinition | null, origin: Vec3, attitude: Quat): Vec3 {
    return proteinSiteWorldPosition(
      site,
      site ? this.siteResidueGroups.get(site.id) ?? [] : [],
      this.controller.residueOffsets,
      this.motion.residueCount,
      this.asset.coordinateScale,
      this.root.scale.x,
      origin,
      attitude,
    );
  }

  localImpactPoint(worldPoint: Vec3, origin: Vec3, attitude: Quat): Vec3 {
    return proteinLocalImpactPoint(worldPoint, origin, attitude, this.root.scale.x);
  }

  dispose(): void {
    this.clearVisuals();
    this.bondMaterial.dispose();
    disposeProteinMotionBinding(this.motionBinding);
  }

}
