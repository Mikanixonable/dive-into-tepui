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
import { proteinMotionModeDisplacements } from './protein-motion-modes';
import {
  createProteinMotionBinding,
  disposeProteinMotionBinding,
  updateProteinMotionCoefficients,
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
  private readonly baseSitePositions = new Map<string, THREE.Vector3>();
  private readonly siteResidueGroups = new Map<string, readonly number[]>();
  private trackedResidues: readonly number[] = [];
  private readonly trackedResidueOffsets: Float32Array;
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
    this.motionBinding = motionBinding ?? createProteinMotionBinding(
      motion.residueCount, proteinMotionModeDisplacements(motion), motion.modes.length,
    );
    if (this.motionBinding.residueCount !== motion.residueCount) {
      throw new RangeError('Protein motion binding and asset residue counts must match');
    }
    this.trackedResidueOffsets = new Float32Array(motion.residueCount * 4);
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
    this.baseSitePositions.clear();
    this.siteResidueGroups.clear();
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
    this.trackedResidues = [...new Set([...this.siteResidueGroups.values()].flat())];
  }

  /** 投影サイズから LOD をヒステリシス付きで更新する。marker になったフレームは
   * 重い更新をしないので、CPU/upload の計測も正直に 0 へ戻す。 */
  updateLod(projectedDiameterPx: number): ProteinMotionLod {
    this.currentLod = proteinMotionLodForProjectedSize(projectedDiameterPx, this.currentLod);
    if (this.currentLod === 'marker') {
      this.lastCpuMs = 0;
      this.lastUploadBytes = 0;
    }
    return this.currentLod;
  }

  /** モード係数を更新して GPU へ送り、アンカーが使う残基だけを CPU 側で投影する。
   * `vibrationEnabled` が false の間は marker LOD 相当のモード係数(全ゼロ)を使い、
   * 静止した構造で表示する。 */
  updateVisual(displayTime: number, vibrationEnabled = true): void {
    const cpuStart = performance.now();
    this.controller.update(displayTime, vibrationEnabled ? this.currentLod : 'marker', this.combat.phase);
    if (this.uploadedLod !== this.currentLod || this.uploadedSampleTime !== this.controller.sampleTime
      || this.uploadedPhase !== this.combat.phase) {
      const coefficients = this.controller.effectiveModeCoefficients;
      updateProteinMotionCoefficients(this.motionBinding, coefficients);
      this.uploadedLod = this.currentLod;
      this.uploadedSampleTime = this.controller.sampleTime;
      this.uploadedPhase = this.combat.phase;
      this.lastUploadBytes = coefficients.byteLength;
    } else {
      this.lastUploadBytes = 0;
    }
    this.controller.projectResidues(this.trackedResidues, this.trackedResidueOffsets);
    this.lastCpuMs = performance.now() - cpuStart;
    const scale = this.asset.coordinateScale;
    const state = this.combat;
    for (const site of this.asset.sites) {
      const mesh = this.siteMeshes.get(site.id);
      const base = this.baseSitePositions.get(site.id);
      const siteState = state.siteState(site.id);
      if (!mesh || !base || !siteState) continue;
      setProteinAnchorPosition(mesh, base, this.siteResidueGroups.get(site.id) ?? [], this.trackedResidueOffsets, this.motion.residueCount, scale);
      mesh.visible = true;
      const material = mesh.material as THREE.MeshStandardMaterial;
      const ratio = siteState.maxHp > 0 ? Math.max(0, Math.min(1, siteState.hp / siteState.maxHp)) : 0;
      material.opacity = siteState.disabled ? 0.18 : 0.32 + ratio * 0.68;
      material.emissiveIntensity = (siteState.disabled ? 0.05 : 0.25 + ratio * 0.5) + (state.phase === 'critical' ? 0.35 : 0);
      mesh.scale.setScalar(0.55 + ratio * 0.45);
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

  siteWorldPositionById(id: string, origin: Vec3, attitude: Quat): Vec3 {
    return this.siteWorldPosition(this.combat.site(id), origin, attitude);
  }

  private siteWorldPosition(site: ProteinSiteDefinition | null, origin: Vec3, attitude: Quat): Vec3 {
    return proteinSiteWorldPosition(
      site,
      site ? this.siteResidueGroups.get(site.id) ?? [] : [],
      this.trackedResidueOffsets,
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
