import * as THREE from 'three/webgpu';
import type { PartPlacement, VesselAssembly } from './assembly';
import { buildHullMesh } from './hull-mesh';
import { partVisualRefOf, type PartVisualRef } from './part-visual';
import { deriveCapsules } from './collision-shape';
import { buildVesselWireframe } from '../../render/vessel-wireframe';
import { disposeOwnedResources } from '../../render/owned-resources';

export interface PartVisualContext {
  readonly partRef: string;
  readonly placement: PartPlacement;
  readonly selected: boolean;
  readonly preview: boolean;
  readonly invalidReason: string | null;
}

export interface PartVisual {
  readonly partRef: string;
  readonly object: THREE.Object3D;
  update(context: PartVisualContext): void;
  dispose(): void;
}

function setAppearance(object: THREE.Object3D, selected: boolean, preview: boolean, invalid: boolean): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const material = mesh.material;
    if (!material || Array.isArray(material)) return;
    const standard = material as THREE.MeshStandardMaterial;
    if ('emissive' in standard) {
      standard.emissive.setHex(invalid ? 0x7f1600 : selected ? 0x5c2b00 : 0x000000);
      standard.emissiveIntensity = invalid || selected ? 0.8 : 0;
    }
    if ('opacity' in standard) {
      standard.transparent = preview;
      standard.opacity = preview ? 0.55 : 1;
      standard.depthWrite = !preview;
    }
  });
}

class AssemblyPartVisual implements PartVisual {
  public constructor(public readonly partRef: string, public readonly object: THREE.Object3D) {}

  update(context: PartVisualContext): void {
    setAppearance(this.object, context.selected, context.preview, context.invalidReason !== null);
    this.object.userData['invalidReason'] = context.invalidReason;
  }

  dispose(): void {
    disposeOwnedResources(this.object);
    this.object.removeFromParent();
  }
}

/** Owns the render tree for one assembly and exposes stable part-level visuals. */
export class AssemblyRenderObject {
  public readonly object: THREE.Group;
  private readonly wireframe: THREE.Object3D;
  private readonly visuals = new Map<string, AssemblyPartVisual>();

  public constructor(assembly: VesselAssembly) {
    this.object = buildHullMesh(assembly);
    for (const [index, placement] of assembly.placements.entries()) {
      const ref = partVisualRefOf(placement, index);
      const object = this.findPartObject(ref) ?? new THREE.Group();
      if (!object.parent) this.object.add(object);
      this.visuals.set(ref.partId, new AssemblyPartVisual(ref.partId, object));
    }
    // ノード・エッジの拾い上げ用ワイヤーフレーム。外皮メッシュ自体は拾えないので、選択・
    // 掴み上げの対象は常にこちらが持つ。既定では隠れている。
    this.wireframe = buildVesselWireframe(assembly.tree, deriveCapsules(assembly.tree));
    this.wireframe.visible = false;
    this.object.add(this.wireframe);
  }

  public visual(partRef: string): PartVisual | null { return this.visuals.get(partRef) ?? null; }

  public update(contexts: readonly PartVisualContext[]): void {
    for (const context of contexts) this.visuals.get(context.partRef)?.update(context);
  }

  // ノード・エッジの表示可否。組立対象として選ばれている間だけ拾えるようにする。
  public setStructureVisible(visible: boolean): void { this.wireframe.visible = visible; }

  // partRef の部品だけを隠し、他は表示に戻す。null なら全て表示に戻す —— 掴み上げ中の部品を
  // カーソル追従のゴーストと二重に見せないためのもので、毎フレーム「いま何を掴んでいるか」から
  // 引き直すので、前回隠した分を戻す帳簿は要らない。
  public setHiddenPart(partRef: string | null): void {
    for (const visual of this.visuals.values()) visual.object.visible = visual.partRef !== partRef;
  }

  // 部品ビジュアルを個別に解放してから外す。残る外皮メッシュとワイヤーフレーム(それぞれ
  // hull-mesh.ts / render/vessel-wireframe.ts が ownsGeometry/ownsMaterial を立てて作る)は
  // disposeOwnedResources が1回の走査で拾う。
  public dispose(): void {
    for (const visual of this.visuals.values()) visual.dispose();
    this.visuals.clear();
    disposeOwnedResources(this.object);
  }

  private findPartObject(ref: PartVisualRef): THREE.Object3D | null {
    let found: THREE.Object3D | null = null;
    this.object.traverse((child) => {
      if (found || child.userData['partVisualRef']?.partId !== ref.partId) return;
      found = child;
    });
    return found;
  }
}
