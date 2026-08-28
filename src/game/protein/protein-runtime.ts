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
  proteinAnchorOffset,
  proteinAnchorResidues,
  proteinLocalImpactPoint,
  proteinSiteWorldPosition,
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
  public readonly combat: ProteinCombatState;
  private readonly motion: ProteinMotionAsset;
  private readonly controller: ProteinMotionController;
  public readonly motionBinding: ProteinMotionBinding;
  private readonly root: THREE.Object3D;
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

  public constructor(
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

  private get asset(): ProteinAssetDefinition { return this.combat.asset; }
  public get hudSnapshot(): ProteinHudSnapshot { return this.combat.hudSnapshot(); }
  public get lod(): ProteinMotionLod { return this.currentLod; }
  public get cpuMs(): number { return this.lastCpuMs; }
  public get uploadBytes(): number { return this.lastUploadBytes; }

  public clearVisuals(): void {
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
    this.baseSitePositions.clear();
    this.siteResidueGroups.clear();
    this.bondVisuals.length = 0;
  }

  public rebuildVisuals(): void {
    this.clearVisuals();
    const scale = this.asset.coordinateScale;
    for (let index = 0; index < this.asset.sites.length; index += 1) {
      const site = this.asset.sites[index]!;
      const [x, y, z] = site.position;
      this.baseSitePositions.set(site.id, new THREE.Vector3(x * scale, y * scale, z * scale));
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
  public updateLod(projectedDiameterPx: number): ProteinMotionLod {
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
  public updateVisual(displayTime: number, vibrationEnabled = true): void {
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
    for (const bond of this.bondVisuals) {
      const fromBase = this.baseSitePositions.get(bond.fromSiteId);
      const toBase = this.baseSitePositions.get(bond.toSiteId);
      if (!fromBase || !toBase) continue;
      const fromOffset = proteinAnchorOffset(this.siteResidueGroups.get(bond.fromSiteId) ?? [], this.trackedResidueOffsets, this.motion.residueCount);
      const toOffset = proteinAnchorOffset(this.siteResidueGroups.get(bond.toSiteId) ?? [], this.trackedResidueOffsets, this.motion.residueCount);
      const positions = bond.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      positions.setXYZ(0, fromBase.x + fromOffset[0] * scale, fromBase.y + fromOffset[1] * scale, fromBase.z + fromOffset[2] * scale);
      positions.setXYZ(1, toBase.x + toOffset[0] * scale, toBase.y + toOffset[1] * scale, toBase.z + toOffset[2] * scale);
      positions.needsUpdate = true;
    }
    this.bondMaterial.opacity = state.phase === 'intact' ? 0.42 : state.phase === 'critical' ? 0.12 : 0.68;
  }

  public activeSiteWorldPosition(origin: Vec3, attitude: Quat): Vec3 {
    return this.siteWorldPosition(this.combat.activeSite, origin, attitude);
  }

  public nextAttackSiteWorldPosition(origin: Vec3, attitude: Quat): Vec3 {
    return this.siteWorldPosition(this.combat.nextAttackSite(), origin, attitude);
  }

  public siteWorldPositionById(id: string, origin: Vec3, attitude: Quat): Vec3 {
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

  public localImpactPoint(worldPoint: Vec3, origin: Vec3, attitude: Quat): Vec3 {
    return proteinLocalImpactPoint(worldPoint, origin, attitude, this.root.scale.x);
  }

  public dispose(): void {
    this.clearVisuals();
    this.bondMaterial.dispose();
    disposeProteinMotionBinding(this.motionBinding);
  }

}
