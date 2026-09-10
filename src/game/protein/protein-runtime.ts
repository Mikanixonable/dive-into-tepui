import * as THREE from 'three/webgpu';
import type { Quat } from '../../math/quat';
import type { Vec3 } from '../../math/vec3';
import type {
  ProteinAssetDefinition,
  ProteinMotionAsset,
  ProteinPhase,
  ProteinSiteDefinition,
} from './protein-schema';
import {
  proteinAnchorOffset,
  proteinAnchorResidues,
  proteinSiteWorldPosition,
} from './protein-anchors';
import {
  projectProteinResidues,
  type ProteinMotionDisplay,
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

// 外部で計算済みのタンパク質変形を反映する GPU 資源と、転送・アンカー計算キャッシュを保つ。
export class ProteinRuntime {
  private readonly motion: ProteinMotionAsset;
  // 共有バッファのスロットが尽きていれば null。そのときは変形せず、静止した構造で描く。
  public readonly motionBinding: ProteinMotionBinding | null;
  private readonly root: THREE.Object3D;
  private readonly siteDefinitions = new Map<string, ProteinSiteDefinition>();
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

  // root に binding と部位・結合線の表示資源を結び付ける。
  public constructor(
    root: THREE.Object3D,
    private readonly asset: ProteinAssetDefinition,
    motion: ProteinMotionAsset,
    motionBinding?: ProteinMotionBinding | null,
  ) {
    // 固定定義の索引と、外部係数を適用する binding を同じ runtime に束ねる。
    this.root = root;
    this.motion = motion;
    for (const site of asset.sites) this.siteDefinitions.set(site.id, site);
    this.motionBinding = motionBinding ?? createProteinMotionBinding(
      motion.residueCount, proteinMotionModeDisplacements(motion), motion.modes.length,
    );
    if (this.motionBinding !== null && this.motionBinding.residueCount !== motion.residueCount) {
      throw new RangeError('Protein motion binding and asset residue counts must match');
    }
    this.trackedResidueOffsets = new Float32Array(motion.residueCount * 4);
    this.bondMaterial = new THREE.LineBasicMaterial({ color: 0x60d9ff, transparent: true, opacity: 0.42 });
    this.rebuildVisuals();
  }

  public get cpuMs(): number { return this.lastCpuMs; }
  public get uploadBytes(): number { return this.lastUploadBytes; }

  // runtime が追加した THREE 子要素と、その参照キャッシュだけを空にする。
  public clearVisuals(): void {
    // userData の印がある子だけを対象にし、定義側が作った本体形状は残す。
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
    // THREE 資源と対応する索引を同時に空へ戻す。
    this.baseSitePositions.clear();
    this.siteResidueGroups.clear();
    this.bondVisuals.length = 0;
  }

  // asset の部位・結合情報から、表示用 THREE 資源とアンカー索引を作り直す。
  public rebuildVisuals(): void {
    // 再着色後にも呼べるよう、旧 runtime 資源を必ず除いてから作る。
    this.clearVisuals();
    const scale = this.asset.coordinateScale;
    for (let index = 0; index < this.asset.sites.length; index += 1) {
      const site = this.asset.sites[index]!;
      const [x, y, z] = site.position;
      this.baseSitePositions.set(site.id, new THREE.Vector3(x * scale, y * scale, z * scale));
      this.siteResidueGroups.set(site.id, proteinAnchorResidues(site, index, this.motion, this.motion.bindings.siteResidues));
    }
    // 結合線は部位 id で保持し、sync 時に変形済みアンカーへ端点を更新する。
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
    this.trackedResidues = [...new Set([...this.siteResidueGroups.values()].flat())];
  }

  // 外部で確定した LOD・係数を GPU とアンカー位置へ反映する。
  public syncVisual(display: ProteinMotionDisplay): void {
    if (!display.active || display.lod === 'marker') {
      this.lastCpuMs = 0;
      this.lastUploadBytes = 0;
      return;
    }
    // GPU 転送は完全な入力キーが変わったフレームだけ行う。
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
    // DOM 部位マーカーと結合線が GPU 変形と同じ位置を使えるよう、必要な残基だけ CPU 投影する。
    projectProteinResidues(
      this.motion, display.coefficients, this.trackedResidues, this.trackedResidueOffsets,
    );
    this.lastCpuMs = performance.now() - cpuStart;
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

  // 部位 id の変形済みアンカーを、指定されたワールド姿勢へ写す。
  public siteWorldPositionById(id: string, origin: Vec3, attitude: Quat): Vec3 {
    return this.siteWorldPosition(this.siteDefinitions.get(id) ?? null, origin, attitude);
  }

  // 変形済みローカルアンカーを、外部から渡された個体姿勢でワールド座標へ写す。
  private siteWorldPosition(site: ProteinSiteDefinition | null, origin: Vec3, attitude: Quat): Vec3 {
    // 部位が見つからない場合も共通変換へ null を渡し、origin 基準の安全な結果にする。
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

  // runtime が所有する THREE/GPU 資源をすべて破棄する。
  public dispose(): void {
    this.clearVisuals();
    this.bondMaterial.dispose();
    if (this.motionBinding !== null) disposeProteinMotionBinding(this.motionBinding);
  }
}
