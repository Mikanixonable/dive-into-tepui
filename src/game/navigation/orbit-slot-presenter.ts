// 軌道標識の表示のまとめ役: 台帳の標識ごとに、軌道線の宣言・位相点の ⌾ マーカー宣言・
// 被選択物をこのフレームの表示へ揃える。標識は実体ではない — 位置も線の形も、参照軌道の
// 記述から時刻を引いて決まる。
import type * as THREE from 'three/webgpu';
import type { CelestialBody } from '../../physics/celestial-body';
import { isOccluded } from '../../physics/occlusion';
import type { CameraFrame } from '../../render/camera/camera-frame';
import { LINE_RENDER_ORDER, type LineStyle } from '../../render/line-style';
import {
  OrbitSlotLinesView, type OrbitSlotLineDisplay, type VisibleOrbitSlotLine,
} from '../../render/lines/orbit-slot-lines-view';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { MarkerDevice } from '../../marker/marker-device';
import type { MarkerSink } from '../../marker/marker-sink';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { ORBIT_POINT_GLYPH } from '../marker/marker-identity';
import { MARKER_PRIORITY } from '../marker/marker-priority';
import { pointPlacement } from '../marker/marker-placement';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import { OrbitSlotPickable } from '../pickable/orbit-slot-pickable';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { ViewMode } from '../view/view-mode';
import type { OrbitSlotCatalogAccess } from './orbit-slot-family';
import { orbitSlotPointAt, orbitSlotStateAt } from './orbit-slot-state';
import type { OrbitSlot } from './orbit-slot';
import type { OrbitSlotRegistry } from './orbit-slot-registry';

// 標識の軌道線の見た目。実体の線(艦・敵・基地)と区別する落ち着いた青紫の細い実線。
const ORBIT_SLOT_LINE_STYLE: LineStyle = {
  color: '#8e9ac7', opacity: 0.5, renderOrder: LINE_RENDER_ORDER.reference,
};

export class OrbitSlotPresenter {
  private readonly linesView: OrbitSlotLinesView;
  // 位相点マーカーの宣言を置く群。
  private readonly group: MarkerSink;
  private readonly declarations: MarkerDeclaration[] = [];
  private readonly displays: OrbitSlotLineDisplay[] = [];
  // 標識ごとの被選択物。id で使い回す。
  private readonly pickablesById = new Map<string, OrbitSlotPickable>();
  private readonly pickableItems: ObjectPickable[] = [];

  // registry は標識の台帳、catalog は族メンバーの焼き込みカタログの読み取り口。
  // simTimeOf は被選択物が「現在状態」を答えるための simTime の供給源。
  public constructor(
    private readonly registry: OrbitSlotRegistry,
    private readonly celestialBodies: CelestialBodies,
    private readonly catalog: OrbitSlotCatalogAccess | null,
    markers: MarkerDevice,
    scene: THREE.Scene,
    private readonly simTimeOf: () => number,
  ) {
    this.linesView = new OrbitSlotLinesView(scene);
    this.group = markers.createGroup();
  }

  // 台帳の全標識の位相点の被選択物。
  public get pickables(): readonly ObjectPickable[] {
    const items = this.pickableItems;
    items.length = 0;
    const seen = new Set<string>();
    for (const slot of this.registry.all()) {
      seen.add(slot.id);
      let pickable = this.pickablesById.get(slot.id);
      if (pickable === undefined) {
        pickable = new OrbitSlotPickable(
          this.registry, slot, this.celestialBodies, this.catalog, this.simTimeOf,
        );
        this.pickablesById.set(slot.id, pickable);
      }
      items.push(pickable);
    }
    for (const id of [...this.pickablesById.keys()]) {
      if (!seen.has(id)) this.pickablesById.delete(id);
    }
    return items;
  }

  // このフレームに表示されている標識の軌道線を、当たり判定用の ECI 点列として列挙する。
  public lineSamples(count: number): readonly VisibleOrbitSlotLine[] {
    return this.linesView.visibleLines(count);
  }

  // 標識の軌道線と位相点マーカーを、このフレームの表示時刻・カメラへ揃える。occluders は
  // 遮蔽判定に使う天体で、occludersPivot はその位置を引く時刻。visibilityPolicy は
  // マップビューの表示可否で、戦闘ビューでは null(標識はマップにだけ出す)。
  public sync(
    displayTime: number, view: ViewMode, camera: CameraFrame,
    occluders: readonly CelestialBody[], occludersPivot: number,
    visibilityPolicy: MapVisibilityPolicy | null, nowMs: number,
  ): void {
    const displays = this.displays;
    const declarations = this.declarations;
    displays.length = 0;
    declarations.length = 0;
    if (view === 'map') {
      for (const slot of this.registry.all()) {
        const visibility = visibilityPolicy?.orbitSlot();
        if (visibility !== undefined && visibility.orbit) {
          const display = this.lineDisplay(slot, displayTime);
          if (display !== null) displays.push(display);
        }
        if (visibility !== undefined && visibility.icon) {
          declarations.push(this.markerDeclaration(
            slot, displayTime, visibility.label, camera, occluders, occludersPivot,
          ));
        }
      }
    }
    this.linesView.sync(displays, camera);
    this.group.sync(declarations, nowMs);
  }

  // 所有する描画資源とマーカー群を取り除く。
  public dispose(): void {
    this.linesView.dispose();
    this.group.dispose();
  }

  // 標識1件ぶんの軌道線の宣言。位相を一周させて得た形を、始点相対の解析曲線として渡す。
  // 軌道が解けない標識は null(その回は描かれない)。
  private lineDisplay(slot: OrbitSlot, displayTime: number): OrbitSlotLineDisplay | null {
    const origin = orbitSlotPointAt(slot, displayTime, 0, this.celestialBodies, this.catalog);
    if (origin === null) return null;
    const bodies = this.celestialBodies;
    const catalog = this.catalog;
    return {
      key: slot.id,
      ownerKeys: this.ownerKeysOf(slot),
      origin,
      style: ORBIT_SLOT_LINE_STYLE,
      shape: {
        kind: 'analytic',
        sample: (phase, out) => {
          const p = orbitSlotPointAt(slot, displayTime, phase, bodies, catalog);
          if (p === null) out.set(0, 0, 0);
          else out.set(p.x - origin.x, p.y - origin.y, p.z - origin.z);
        },
      },
    };
  }

  // 軌道線1本の所属先。先頭は標識自身、要素型は基準天体、族型は主星・副星を添える。
  private ownerKeysOf(slot: OrbitSlot): readonly string[] {
    const orbit = slot.orbit;
    return orbit.kind === 'elements'
      ? [slot.id, orbit.bodyId]
      : [slot.id, orbit.primaryId, orbit.secondaryId];
  }

  // 位相点の ⌾ マーカー1件ぶんの宣言。軌道が解けない・天体に遮られたフレームは伏せる。
  private markerDeclaration(
    slot: OrbitSlot, displayTime: number, showLabel: boolean, camera: CameraFrame,
    occluders: readonly CelestialBody[], occludersPivot: number,
  ): MarkerDeclaration {
    const base = {
      id: slot.id, cls: 'mk-poi', sym: ORBIT_POINT_GLYPH.orbitSlot,
      priority: MARKER_PRIORITY.ORBITAL_NODE,
    };
    const pos = orbitSlotStateAt(slot, displayTime, this.celestialBodies, this.catalog)?.r ?? null;
    if (pos === null) return { ...base, x: 0, y: 0, front: false };
    if (isOccluded(camera.position, pos, occluders, occludersPivot)) {
      return { ...base, x: 0, y: 0, front: false, occluded: true };
    }
    return {
      ...base,
      ...pointPlacement(pos, camera.project, camera.position),
      label: showLabel ? slot.name : undefined,
    };
  }
}
