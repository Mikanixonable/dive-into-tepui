// クリエイティブモードの物体配置。配置パネルを持ち、フォームの値を検証して初期状態を組み、
// 置くと決まった物体の指定を受け手へ渡す。配置プレビューをどの値で出すかもここが決める。
import { OrbitingMotion } from '../../physics/celestial-motion';
import { orbitalElementsOf, semiMajorFromPeriod, stateFromOrbitalElements, type OrbitalElements } from '../../physics/elements';
import { haloState, lissajousState } from '../../physics/halo';
import { addPrimaryRelative, kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { secondaryFrameOf } from '../../physics/lagrange';
import { isOccluded } from '../../physics/occlusion';
import { ObjectPlacementPreviewView } from '../../render/creative/object-placement-preview-view';
import { LINE_RENDER_ORDER, type LineStyle } from '../../render/line-style';
import { EntityIdAllocator, type EntityIdAllocators } from '../dynamic/dynamic-entity/entity-id';
import { AmmoPickup, RcsFuelPickup } from '../dynamic/dynamic-entity/pickup';
import { isModularShip, type ModularShipInit } from '../ship/modular-ship';
import { createBasePreset } from '../ship/ship-presets';
import { generateRandomName } from '../random-name';
import { generateDriftingEnemy } from '../stages/spawner/enemy-generator';
import { elementsFormFromState } from './duplicate-form';
import {
  ObjectPlacerPanel, type ElementsForm, type LagrangeForm, type ObjectPlacementSelection,
  type ObjectPlacerForm, type ReferenceCelestialBody,
} from './object-placer-panel';
import {
  validateBaseReferenceFields, validateEllipticPlacementFields, validateLagrangePlacementFields,
  type PlacementFieldIssue,
} from './placement-validation';
import { MARKER_PRIORITY } from '../marker/marker-priority';
import { pointPlacement } from '../marker/marker-placement';
import { COLOR_MARKER_ALLY, ENTITY_GLYPH } from '../marker/marker-identity';
import type * as THREE from 'three/webgpu';
import type { Vec3 } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { RunEventSink } from '../run-events';
import type { HudLayers } from '../hud/hud-layers';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { ViewMode } from '../view/view-mode';

// 軌道上へ配置できる自機の上限隻数。
export const MAX_PLACED_SHIPS = 50;

export function reachesPlacedShipLimit(selection: ObjectPlacementSelection, currentShipCount: number): boolean {
  return (selection === 'combat-ship' || selection === 'base-ship')
    && currentShipCount >= MAX_PLACED_SHIPS;
}

// 配置プレビューの軌道線の見た目。
const PREVIEW_LINE_STYLE: LineStyle = {
  color: 0xffffff, opacity: 0.6, renderOrder: LINE_RENDER_ORDER.plan,
};

const DEG = Math.PI / 180;

// 配置プレビューの ▷ マーカーの id。
const PREVIEW_MARKER_ID = 'creative-preview';

// 置くと決まった物体。自機は実体ではなく配置の指定で表す。
export type PlacedObject =
  | { readonly kind: 'ship'; readonly init: ModularShipInit }
  | { readonly kind: 'entity'; readonly entity: DynamicEntity };

// 配置した自機の id の、次に発番する連番。
export interface SerializedObjectPlacement {
  readonly playerIdAllocator: number;
}

// 検証を通った配置の指定の受け手。実体を作るのは受け手の側。
export interface ObjectPlacementSink {
  placeObject(name: string, selection: ObjectPlacementSelection, state: KinematicState): void;
}

export class ObjectPlacement {
  private readonly panel: ObjectPlacerPanel;
  private readonly previewView: ObjectPlacementPreviewView;
  // このフレームのプレビュー ▷ マーカーの宣言。
  private readonly declarations: MarkerDeclaration[] = [];
  private readonly playerIdAllocator: EntityIdAllocator;

  // 配置パネルとプレビューの表示資源を組む。placements は検証を通った配置の指定の受け手。
  // playerIdCounter は配置した自機の id の次に発番する連番で、省けば連番の初めから発番する。
  public constructor(
    hud: HudLayers,
    private readonly scene: THREE.Scene,
    private readonly roster: EntityRoster,
    private readonly idAllocators: EntityIdAllocators,
    private readonly events: RunEventSink,
    private readonly celestialSystem: CelestialSystem,
    private readonly placements: ObjectPlacementSink,
    playerIdCounter = 0,
  ) {
    this.playerIdAllocator = new EntityIdAllocator('creative-player-', playerIdCounter);

    this.previewView = new ObjectPlacementPreviewView(scene, PREVIEW_LINE_STYLE);

    this.panel = new ObjectPlacerPanel(celestialSystem, hud.overlayManager);
    this.panel.onConfirm = (name, form) => this.place(name, form);
  }

  // 配置した自機の id の連番を直列化した形へ畳む。
  public serialize(): SerializedObjectPlacement {
    return { playerIdAllocator: this.playerIdAllocator.serialize() };
  }

  // オブジェクト配置モーダルを開く。focusId が基準天体になれる ID なら、基準天体の初期選択に使う。
  public openObjectPlacer(focusId?: string): void {
    this.panel.open(focusId !== undefined ? { kind: 'body', celestialBody: focusId as ReferenceCelestialBody } : undefined);
  }

  // 種類と軌道要素を引き継いで配置パネルを開く。state を軌道要素へ逆算できないか基地の基準天体
  // 制約に反するときは、種類だけを引き継ぎ、軌道を複製できなかったことを記録する。
  public openObjectPlacerForDuplicate(entityKind: DynamicEntityKind, state: KinematicState): void {
    const selection: ObjectPlacementSelection = entityKind === 'player' ? 'combat-ship'
      : entityKind === 'base' ? 'base-ship' : entityKind;
    const form = elementsFormFromState(
      state, this.celestialSystem, state.t, this.celestialSystem.origin.id);
    if (form && validateBaseReferenceFields(selection, 'elements', form.celestialBody).length === 0) {
      this.panel.open({ kind: 'form', selection, form });
      return;
    }
    this.events.record({ kind: 'orbitNotDuplicable' });
    this.panel.open({ kind: 'selection', selection });
  }

  // 開いているフォームの現在値から、配置プレビューと入力欄の検証表示を更新する。
  public sync(camera: CameraFrame, view: ViewMode, displayTime: number): void {
    const form = this.panel.isOpen ? this.panel.getForm() : null;
    const preview = form ? this.computePreview(form) : null;
    this.previewView.sync(preview?.elements ?? null, PREVIEW_LINE_STYLE, camera);
    this.declarations.length = 0;
    this.declarations.push(this.previewMarker(preview?.pos ?? null, camera, view, displayTime));
    this.panel.setIssues(form ? this.computeFieldIssues(form) : []);
  }

  // 直近の sync が組んだ、このフレームのマーカーの宣言。
  public get markerDeclarations(): readonly MarkerDeclaration[] { return this.declarations; }

  // このモジュールが持つ表示物とパネルを片付ける。
  public dispose(): void {
    this.previewView.dispose();
    this.panel.dispose();
  }

  // フォーム値から配置プレビューの軌道要素と位置を求める。軌道要素指定以外の配置方法・
  // 入力を解釈できない値のときは null(プレビューを出さない)。
  private computePreview(form: ObjectPlacerForm): { elements: OrbitalElements; pos: Vec3 } | null {
    if (form.placementMode !== 'elements') return null;
    try {
      const state = this.buildInitialState(form);
      const elements = orbitalElementsOf(state, this.referenceCelestialBody(form), state.t);
      return elements ? { elements, pos: state.r } : null;
    } catch {
      return null;
    }
  }

  // プレビューの ▷ マーカーの宣言。pos はプレビューの ECI 位置で、プレビューを出せない
  // フレームでは null。
  private previewMarker(
    pos: Vec3 | null, camera: CameraFrame, view: ViewMode, displayTime: number,
  ): MarkerDeclaration {
    const base = {
      id: PREVIEW_MARKER_ID, cls: 'mk-self', sym: ENTITY_GLYPH.preview,
      priority: MARKER_PRIORITY.PLAYER,
    };
    // 位置が無いときと、マップ視点で天体に遮られているときは、画面上の位置を示さない。
    if (pos === null) return { ...base, x: 0, y: 0, front: false, occluded: true };
    if (view === 'map'
      && isOccluded(camera.position, pos, this.celestialSystem.celestialMotions, displayTime)) {
      return { ...base, x: 0, y: 0, front: false };
    }
    return {
      ...base,
      ...pointPlacement(pos, camera.project, camera.position),
      label: 'PREVIEW', color: COLOR_MARKER_ALLY, rotationDeg: 0,
    };
  }

  // フォームの値を検証して初期状態を組み、置く物体の指定を受け手へ渡す。
  // 検証に落ちるか状態を組めなければ、落ちた理由を記録して何も渡さない。
  private place(name: string, form: ObjectPlacerForm): void {
    // combat/base preset は同じ ModularShip 上限を共有する(SPEC GAME.md 9.1)。
    if (reachesPlacedShipLimit(form.selection, this.roster.all().filter(isModularShip).length)) {
      this.events.record({ kind: 'shipPlacementLimitReached', limit: MAX_PLACED_SHIPS });
      return;
    }
    try {
      this.assertValidForm(form);
      const state = this.buildInitialState(form);
      this.assertFiniteEllipticState(state);
      this.placements.placeObject(name, form.selection, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : '入力を解釈できません';
      this.events.record({ kind: 'objectPlacementRejected', reason: message });
    }
  }

  // 種類ごとに実体を作り、id を採番して、空欄の名前を種類ごとの既定名で埋める。
  public createObject(name: string, selection: ObjectPlacementSelection, state: KinematicState): PlacedObject {
    // 自機は生成引数、それ以外は実体として返す。
    switch (selection) {
      case 'combat-ship': {
        const id = this.playerIdAllocator.next();
        return { kind: 'ship', init: { name: name.trim() || generateRandomName('player'), state, id } };
      }
      case 'enemy': {
        const finalName = name.trim() || generateRandomName('enemy');
        return {
          kind: 'entity',
          entity: generateDriftingEnemy(
            finalName, state, '#ff6a00', '#ff6a00', this.scene, this.idAllocators,
          ),
        };
      }
      case 'ammo':
        {
          const finalName = name.trim() || generateRandomName('ammo');
        return {
          kind: 'entity',
          entity: AmmoPickup.create({ state, name: finalName }, this.scene, this.idAllocators),
        };
        }
      case 'fuel':
        {
          const finalName = name.trim() || generateRandomName('fuel');
        return {
          kind: 'entity',
          entity: RcsFuelPickup.create({ state, name: finalName }, this.scene, this.idAllocators),
        };
        }
      case 'base-ship': {
        const id = this.playerIdAllocator.next();
        return {
          kind: 'ship',
          init: {
            name: name.trim() || generateRandomName('base'), state, id, assembly: createBasePreset(),
          },
        };
      }
    }
  }

  // フォームの placementMode に応じて、軌道要素指定かラグランジュ点指定で初期状態を組む。
  private buildInitialState(form: ObjectPlacerForm): KinematicState {
    if (form.placementMode === 'lagrange') return this.buildLagrangeState(form);
    return this.buildElementsState(form);
  }

  // ラグランジュ点まわりのハロー/リサジュー軌道の初期状態を組む。
  private buildLagrangeState(form: LagrangeForm): KinematicState {
    const motion = this.celestialSystem.entityOf(form.lagrangeSecondary).motion;
    if (!(motion instanceof OrbitingMotion)) {
      throw new Error(`buildLagrangeState: ${form.lagrangeSecondary} は公転していないのでラグランジュ点を持たない`);
    }
    // 現在時刻の主天体・副天体系から、ハロー/リサジュー軌道の初期状態を算出する。
    const t = this.roster.simTime;
    const system = secondaryFrameOf(this.celestialSystem.celestialMotions, t, motion, t);
    if (system === null) {
      throw new Error(`buildLagrangeState: ${form.lagrangeSecondary} の主天体が引けない`);
    }
    if (form.lagrangeOrbitKind === 'halo') {
      return haloState(system, { point: form.lagrangePoint, az: form.azKm * 1e3 });
    }
    return lissajousState(system, { point: form.lagrangePoint, ax: form.axKm * 1e3, az: form.azKm * 1e3 });
  }

  // フォームが選んだ基準天体の運動を引く。
  private referenceCelestialBody(form: ElementsForm): CelestialBody {
    return this.celestialSystem.motionOf(form.celestialBody);
  }

  // フォームのサイズ/形の指定から軌道要素を組み、基準天体中心の状態を ECI へ直して返す。
  private buildElementsState(form: ElementsForm): KinematicState {
    const center = this.referenceCelestialBody(form);
    const centerState = center.stateAt(this.roster.simTime);
    // サイズの指定方法ごとに長半径と離心率を出す。
    let a: number;
    let e: number;
    if (form.sizeMode === 'apsides') {
      const rp = center.def.radius + form.peAltKm * 1e3;
      const ra = center.def.radius + form.apAltKm * 1e3;
      a = (rp + ra) / 2;
      e = (ra - rp) / (ra + rp);
    } else if (form.sizeMode === 'semiMajorEcc') {
      a = form.semiMajorKm * 1e3;
      e = form.eccentricity;
    } else {
      a = semiMajorFromPeriod(form.periodHours * 3600, center.def.mu);
      e = form.eccentricity;
    }

    // 基準天体中心の相対状態を ECI へ直す。
    const rel = stateFromOrbitalElements(
      this.roster.simTime, a, e, form.incDeg * DEG, form.raanDeg * DEG, form.argpDeg * DEG,
      form.nuDeg * DEG, center.def.mu,
    );
    return addPrimaryRelative(centerState, kinematicState<'primaryRel'>(rel.t, rel.r, rel.v));
  }

  // フォーム値をフィールド単位で検証する。
  private computeFieldIssues(form: ObjectPlacerForm): PlacementFieldIssue[] {
    // 配置方法によらず効く、種類ごとの基準天体の制約。
    const issues = [...validateBaseReferenceFields(
      form.selection, form.placementMode, form.placementMode === 'elements' ? form.celestialBody : undefined,
    )];
    // 配置方法ごとの制約。
    if (form.placementMode === 'elements') {
      const center = this.referenceCelestialBody(form);
      const common = {
        centerRadius: center.def.radius, mu: center.def.mu, centerId: center.id,
        incDeg: form.incDeg, raanDeg: form.raanDeg, argpDeg: form.argpDeg, nuDeg: form.nuDeg,
      };
      issues.push(...validateEllipticPlacementFields(
        form.sizeMode === 'apsides' ? { ...common, sizeMode: 'apsides', peAltKm: form.peAltKm, apAltKm: form.apAltKm }
        : form.sizeMode === 'semiMajorEcc'
          ? { ...common, sizeMode: 'semiMajorEcc', semiMajorKm: form.semiMajorKm, eccentricity: form.eccentricity }
          : { ...common, sizeMode: 'periodEcc', periodHours: form.periodHours, eccentricity: form.eccentricity },
      ));
    } else {
      issues.push(...validateLagrangePlacementFields(
        form.lagrangeOrbitKind === 'halo'
          ? { orbitKind: 'halo', outOfPlaneAmplitudeKm: form.azKm }
          : { orbitKind: 'lissajous', inPlaneAmplitudeKm: form.axKm, outOfPlaneAmplitudeKm: form.azKm },
      ));
    }
    return issues;
  }

  // フォームの値が物理的に成立するか検証し、不正なら最初の問題を理由に例外を投げる。
  private assertValidForm(form: ObjectPlacerForm): void {
    const [firstIssue] = this.computeFieldIssues(form);
    if (firstIssue) throw new Error(firstIssue.message);
  }

  // 位置・速度に非有限値が混じっていたら例外を投げる。
  private assertFiniteEllipticState(state: KinematicState): void {
    const values = [state.r.x, state.r.y, state.r.z, state.v.x, state.v.y, state.v.z];
    if (!values.every(Number.isFinite)) throw new Error('有限の状態を作れませんでした');
  }
}
