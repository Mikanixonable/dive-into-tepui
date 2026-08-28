import * as THREE from 'three/webgpu';
import { kinematicState } from '../../physics/kinematic-state';
import { len, sub, v3, type Vec3 } from '../../math/vec3';
import * as C from '../const';
import { buildRcsFuelPickup } from '../../render/ships';
import { GameEntity } from './game-entity';
import { EntityIdAllocator } from './entity-id';
import { DIRECTION_GLYPH, ENTITY_GLYPH } from '../marker/marker-glyphs';
import { fmtMarkerDist } from '../hud/utils';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import type { Attitude } from '../../physics/attitude';
import type { KinematicState } from '../../physics/kinematic-state';
import type { RcsFuelPickupSaveData } from '../save/save-data';

const RCS_FUEL_PHYS_RADIUS = 1.3; // 補給の物理接触用の半径 [m]

const idAllocator = new EntityIdAllocator('rcs-fuel-');

export type RcsFuelPickupInit =
  | { readonly state: KinematicState; readonly att?: Attitude; readonly id?: string }
  | { readonly saved: RcsFuelPickupSaveData; readonly simTime: number };

// 軌道上の RCS 燃料補給。接近すると燃料を艦のタンクへ移す。
export class RcsFuelPickup extends GameEntity {
  override readonly bcInv = C.SMALL_DEBRIS_BCINV;
  protected readonly srpCoeff = C.SMALL_DEBRIS_SRP_COEFF;
  protected readonly specificHeat = C.SMALL_DEBRIS_SPECIFIC_HEAT;
  protected readonly bulkDensity = C.SMALL_DEBRIS_BULK_DENSITY;
  protected override get radiatingAreaPerMass(): number {
    return C.SMALL_DEBRIS_RADIATING_AREA_PER_MASS;
  }
  protected readonly maxTemperature = C.SMALL_DEBRIS_MAX_TEMP;
  protected readonly predictedForGhost = true;

  public constructor(init: RcsFuelPickupInit, scene: THREE.Scene) {
    const { state, att, id } = 'saved' in init
      ? {
        state: kinematicState(init.simTime, v3(init.saved.r.x, init.saved.r.y, init.saved.r.z), v3(init.saved.v.x, init.saved.v.y, init.saved.v.z)),
        att: { q: { ...init.saved.q }, w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z), inertia: v3(1, 1, 1) } as Attitude,
        id: init.saved.id || undefined,
      }
      : { state: init.state, att: init.att, id: init.id };
    super(state, buildRcsFuelPickup(), scene, att, idAllocator.next(id));
    this.name = ('saved' in init && init.saved.name) ? init.saved.name : 'RCS燃料';
    this.mass = 0;
    this.radius = RCS_FUEL_PHYS_RADIUS;
    this.collides = true;
    this.contactDamageWeight = 0;
  }

  serialize(): RcsFuelPickupSaveData {
    return {
      id: this.id,
      ...(this.name !== 'RCS燃料' ? { name: this.name } : {}),
      kind: 'rcs-fuel',
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
    };
  }

  markerItem(viewerPos: Vec3, overviewMode: boolean): GroupedMarkerItem {
    const dist = len(sub(this.state.r, viewerPos));
    return {
      key: `rcs-fuel-${this.id}`,
      cls: 'mk-fuel',
      sym: ENTITY_GLYPH.fuel,
      pos: this.state.r,
      vel: this.state.v,
      priority: C.MARKER_PRIORITY.AMMO,
      name: this.name,
      detail: overviewMode ? '' : fmtMarkerDist(dist),
      bearingColor: C.COLOR_MARKER_FUEL,
      bearingSym: DIRECTION_GLYPH.bearing,
      bearingClass: 'mk-fuel mk-bearing-triangle',
      symMarkup: false,
    };
  }
}
