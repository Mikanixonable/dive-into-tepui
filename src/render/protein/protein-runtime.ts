import * as THREE from 'three/webgpu';
import {
  proteinAnchorOffset,
  proteinAnchorResidues,
  proteinSiteWorldPosition,
} from './protein-anchors';
import { projectProteinResidues, proteinMotionModeDisplacements } from './protein-motion-modes';
import {
  createProteinMotionBinding,
  disposeProteinMotionBinding,
  updateProteinMotionCoefficients,
  type ProteinMotionBinding,
} from './protein-motion-material';
import type { Quat } from '../../math/quat';
import type { Vec3 } from '../../math/vec3';
import type { ProteinMotionDisplay, ProteinMotionLod, ProteinPhase } from './protein-display';
import type {
  ProteinRenderAsset,
  ProteinRenderMotion,
  ProteinRenderSite,
} from './protein-render-definition';

// runtime が root に加えた子に付ける userData の印。
const RUNTIME_VISUAL = 'protein-runtime-visual';

interface ProteinBondVisual {
  readonly line: THREE.Line;
  readonly fromSiteId: string;
  readonly toSiteId: string;
}

// 1体ぶんの確定済みモード係数を GPU へ渡し、部位のアンカーと結合線を残基変形に合わせる。
export class ProteinRuntime {
  // 共有バッファの空きが尽きていれば null で、そのときは静止した構造で描く。
  public readonly motionBinding: ProteinMotionBinding | null;
  private readonly siteDefinitions = new Map<string, ProteinRenderSite>();
  private readonly baseSitePositions = new Map<string, THREE.Vector3>();
  private readonly siteResidueGroups = new Map<string, readonly number[]>();
  private trackedResidues: readonly number[] = [];
  private readonly trackedResidueOffsets: Float32Array;
  private readonly bondVisuals: ProteinBondVisual[] = [];
  private readonly bondMaterial: THREE.LineBasicMaterial;
  private uploadedLod: ProteinMotionLod | null = null;
  private uploadedSampleTime = Number.NaN;
  private uploadedPhase: ProteinPhase | null = null;
  private lastCpuMs = 0;
  private lastUploadBytes = 0;

  // root に部位の結合線を加える。motionBinding が無ければ自分で借りる。残基数が合わなければ例外。
  public constructor(
    private readonly root: THREE.Object3D,
    private readonly asset: ProteinRenderAsset,
    private readonly motion: ProteinRenderMotion,
    motionBinding?: ProteinMotionBinding | null,
  ) {
    for (const site of asset.sites) this.siteDefinitions.set(site.id, site);
    // 残基変形を解く共有バッファ上の借り位置。
    this.motionBinding = motionBinding ?? createProteinMotionBinding(
      motion.residueCount, proteinMotionModeDisplacements(motion), motion.modes.length,
    );
    if (this.motionBinding !== null && this.motionBinding.residueCount !== motion.residueCount) {
      throw new RangeError('Protein motion binding and asset residue counts must match');
    }
    // アンカーの残基変位を CPU で投影する作業領域と、結合線。
    this.trackedResidueOffsets = new Float32Array(motion.residueCount * 4);
    this.bondMaterial = new THREE.LineBasicMaterial({ color: 0x60d9ff, transparent: true, opacity: 0.42 });
    this.rebuildVisuals();
  }

  // 直前の syncVisual の CPU 時間 [ms] と GPU への転送量 [byte]。
  public get cpuMs(): number { return this.lastCpuMs; }
  public get uploadBytes(): number { return this.lastUploadBytes; }

  // runtime が root に加えた子を破棄し、アンカーの索引を空にする。root の本体の形状は残る。
  public clearVisuals(): void {
    // 印の付いた子を破棄する。
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
    // 対応する索引も空にする。
    this.baseSitePositions.clear();
    this.siteResidueGroups.clear();
    this.bondVisuals.length = 0;
  }

  // asset の部位・結合情報から、表示用 THREE 資源とアンカー索引を作り直す。
  public rebuildVisuals(): void {
    this.clearVisuals();
    // 部位の静止位置と、アンカーを引く残基群。
    const scale = this.asset.coordinateScale;
    for (let index = 0; index < this.asset.sites.length; index += 1) {
      const site = this.asset.sites[index]!;
      const [x, y, z] = site.position;
      this.baseSitePositions.set(site.id, new THREE.Vector3(x * scale, y * scale, z * scale));
      this.siteResidueGroups.set(site.id, proteinAnchorResidues(site, index, this.motion, this.motion.bindings.siteResidues));
    }
    // 結合線を部位の静止位置で引く。端点は syncVisual で動かす。
    for (const bond of this.asset.bonds) {
      const from = this.siteDefinitions.get(bond.from);
      const to = this.siteDefinitions.get(bond.to);
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
    // 変位を CPU でも求める残基。
    this.trackedResidues = [...new Set([...this.siteResidueGroups.values()].flat())];
  }

  // 確定したモード係数を GPU へ渡し、アンカーと結合線を変形に合わせる。active でないか marker なら計測値を 0 にして戻る。
  public syncVisual(display: ProteinMotionDisplay): void {
    if (!display.active || display.lod === 'marker') {
      this.lastCpuMs = 0;
      this.lastUploadBytes = 0;
      return;
    }
    // LOD・標本化時刻・フェーズのどれかが変わったフレームで GPU へ転送する。
    const cpuStart = performance.now();
    if (this.uploadedLod !== display.lod || this.uploadedSampleTime !== display.sampleTime
      || this.uploadedPhase !== display.phase) {
      const coefficients = display.coefficients;
      if (this.motionBinding !== null) updateProteinMotionCoefficients(this.motionBinding, coefficients);
      this.uploadedLod = display.lod;
      this.uploadedSampleTime = display.sampleTime;
      this.uploadedPhase = display.phase;
      this.lastUploadBytes = coefficients.byteLength;
    } else {
      this.lastUploadBytes = 0;
    }
    // アンカーが GPU の変形と同じ位置になるよう、部位の残基を CPU でも投影する。
    projectProteinResidues(
      this.motion, display.coefficients, this.trackedResidues, this.trackedResidueOffsets,
    );
    this.lastCpuMs = performance.now() - cpuStart;
    // 結合線の端点を変形済みアンカーへ動かし、フェーズで濃さを変える。
    const scale = this.asset.coordinateScale;
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
    this.bondMaterial.opacity = display.phase === 'intact'
      ? 0.42
      : display.phase === 'critical' ? 0.12 : 0.68;
  }

  // 部位 id の変形済みアンカーを、個体の位置・姿勢でワールド座標へ写す。id が無ければ origin。
  public siteWorldPositionById(id: string, origin: Vec3, attitude: Quat): Vec3 {
    return this.siteWorldPosition(this.siteDefinitions.get(id) ?? null, origin, attitude);
  }

  // 部位の変形済みアンカーを、個体の位置・姿勢でワールド座標へ写す。site が null なら origin。
  private siteWorldPosition(site: ProteinRenderSite | null, origin: Vec3, attitude: Quat): Vec3 {
    // 残基の変位は、直前の syncVisual で投影したもの。
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

  // root に加えた資源と motionBinding(外から渡したものも)を破棄する。
  public dispose(): void {
    this.clearVisuals();
    this.bondMaterial.dispose();
    if (this.motionBinding !== null) disposeProteinMotionBinding(this.motionBinding);
  }
}
