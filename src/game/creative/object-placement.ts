// クリエイティブモードの物体配置。配置パネルを持ち、フォームの値を検証して初期状態を組み、
// 置くと決まった物体を onPlace へ渡す。配置プレビューをどの値で出すかもここが決める。
import { add } from '../../math/vec3';
import { OrbitingMotion } from '../../physics/celestial-motion';
import { orbitalElementsOf, semiMajorFromPeriod, stateFromOrbitalElements, type OrbitalElements } from '../../physics/elements';
import { haloState, lissajousState } from '../../physics/halo';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { secondaryFrameOf } from '../../physics/lagrange';
import { isOccluded } from '../../physics/occlusion';
import { ObjectPlacementPreviewView } from '../../render/creative/object-placement-preview-view';
import { LINE_RENDER_ORDER, type LineStyle } from '../../render/line-style';
import { Base } from '../dynamic/dynamic-entity/base';
import { EntityIdAllocator } from '../dynamic/dynamic-entity/entity-id';
import { AmmoPickup, isAmmoPickup, isRcsFuelPickup, RcsFuelPickup } from '../dynamic/dynamic-entity/pickup';
import { isPlayer, type PlayerInit } from '../player/player';
import { generateRandomName } from '../random-name';
import { generateDriftingEnemy } from '../stages/spawner/enemy-generator';
import { elementsFormFromState } from './duplicate-form';
import {
  ObjectPlacerPanel, type ElementsForm, type LagrangeForm, type ObjectPlacerForm, type ReferenceCelestialBody,
} from './object-placer-panel';
import {
  validateBaseReferenceFields, validateEllipticPlacementFields, validateLagrangePlacementFields,
  type PlacementFieldIssue,
} from './placement-validation';
import type * as THREE from 'three/webgpu';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import type { Notifier } from '../../hud/notifier';
import type { Vec3 } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { HudLayers } from '../hud/hud-layers';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import { MARKER_PRIORITY } from '../marker/marker-priority';
import { pointPlacement } from '../marker/marker-placement';
import { COLOR_MARKER_ALLY, ENTITY_GLYPH } from '../marker/marker-identity';
import type { FlashEffects } from '../vfx/flash-effects';

// 軌道上へ配置できる自機の上限隻数。
const MAX_PLACED_SHIPS = 50;

// 配置プレビューの軌道線の見た目。
const PREVIEW_LINE_STYLE: LineStyle = {
  color: 0xffffff, opacity: 0.6, renderOrder: LINE_RENDER_ORDER.plan,
};

const DEG = Math.PI / 180;

// 配置プレビューの ▷ マーカーの id。
const PREVIEW_MARKER_ID = 'creative-preview';

// 置くと決まった物体。自機は実体ではなく生成引数で表す。name は与えた名前で、
// 実体が名前を持たない種類(弾薬)でも告知できるよう別に持つ。
export type PlacedObject =
  | { readonly kind: 'player'; readonly init: PlayerInit }
  | { readonly kind: 'entity'; readonly entity: DynamicEntity; readonly name: string };

export class ObjectPlacement {
  private readonly panel: ObjectPlacerPanel;
  private readonly previewView: ObjectPlacementPreviewView;
  // このフレームのプレビュー ▷ マーカーの宣言。
  private readonly declarations: MarkerDeclaration[] = [];
  private readonly playerIdAllocator = new EntityIdAllocator('creative-player-');
  private readonly ammoPickupIdAllocator = new EntityIdAllocator('creative-ammo-');
  private readonly rcsFuelPickupIdAllocator = new EntityIdAllocator('creative-rcs-fuel-');

  // 検証を通った物体の渡し先。
  public onPlace: ((placed: PlacedObject) => void) | null = null;

  // 配置パネルとプレビューの表示資源を組む。
  public constructor(
    private readonly hud: HudLayers & Notifier,
    private readonly scene: THREE.Scene,
    private readonly dynamicSystem: EntityRoster,
    private readonly celestialSystem: CelestialSystem,
    private readonly worldSfx: WorldSfx,
    private readonly fx: FlashEffects,
  ) {
    // 以後の新規配置が既存 id と衝突しないよう、復元済みの艦・補給の id を予約する。
    const entities = dynamicSystem.all();
    for (const p of entities.filter(isPlayer)) this.playerIdAllocator.next(p.id);
    for (const ammoPickup of entities.filter(isAmmoPickup)) this.ammoPickupIdAllocator.next(ammoPickup.id);
    for (const pickup of entities.filter(isRcsFuelPickup)) this.rcsFuelPickupIdAllocator.next(pickup.id);

    this.previewView = new ObjectPlacementPreviewView(scene, PREVIEW_LINE_STYLE);

    this.panel = new ObjectPlacerPanel(hud.mapRoot, hud.layers.popup, celestialSystem, hud.overlayManager);
    this.panel.onConfirm = (name, form) => this.place(name, form);
  }

  // オブジェクト配置モーダルを開く。focusId はマップの現在フォーカスで、
  // 基準天体になれる ID なら基準天体の初期選択に使う。
  public openObjectPlacer(focusId?: string): void {
    this.panel.open(focusId !== undefined ? { kind: 'body', celestialBody: focusId as ReferenceCelestialBody } : undefined);
  }

  // 右クリックメニューの「複製」。state を軌道要素へ逆算でき、基地の基準天体制約も満たす値が
  // 求まったときは、その値をプリセットして開く。逆算できない軌道(双曲線など)や制約に反する
  // 複製元では、値を引き継ぐと制約外の軌道が黙って配置できてしまうので、種類だけを引き継ぐ。
  public openObjectPlacerForDuplicate(entityKind: DynamicEntityKind, state: KinematicState): void {
    const form = elementsFormFromState(
      state, this.celestialSystem, state.t, this.celestialSystem.origin.id);
    if (form && validateBaseReferenceFields(entityKind, 'elements', form.celestialBody).length === 0) {
      this.panel.open({ kind: 'form', entityKind, form });
      return;
    }
    this.hud.hint('この軌道は要素として複製できないため、種類だけを引き継いだ新規配置として開きます');
    this.panel.open({ kind: 'entityKind', entityKind });
  }

  // 開いているフォームの現在値から、配置プレビューと入力欄の検証表示を更新する。
  public sync(camera: CameraFrame, displayTime: number): void {
    const form = this.panel.isOpen ? this.panel.getForm() : null;
    const preview = form ? this.computePreview(form) : null;
    this.previewView.sync(preview?.elements ?? null, PREVIEW_LINE_STYLE, camera);
    this.declarations.length = 0;
    this.declarations.push(this.previewMarker(preview?.pos ?? null, camera, displayTime));
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
      // 楕円はフォームが選んだ基準天体中心で描く。
      const elements = orbitalElementsOf(state, this.referenceCelestialBody(form), state.t);
      return elements ? { elements, pos: state.r } : null;
    } catch {
      return null;
    }
  }

  // プレビューの ▷ マーカーの宣言。pos はプレビューの ECI 位置で、プレビューを出せない
  // フレームでは null。マップ視点で天体に遮られているあいだは位置を示さない。
  private previewMarker(
    pos: Vec3 | null, camera: CameraFrame, displayTime: number,
  ): MarkerDeclaration {
    const base = {
      id: PREVIEW_MARKER_ID, cls: 'mk-self', sym: ENTITY_GLYPH.preview,
      priority: MARKER_PRIORITY.PLAYER,
    };
    if (pos === null) return { ...base, x: 0, y: 0, front: false, occluded: true };
    if (camera.mode === 'map'
      && isOccluded(camera.position, pos, this.celestialSystem.celestialMotions, displayTime)) {
      return { ...base, x: 0, y: 0, front: false };
    }
    return {
      ...base,
      ...pointPlacement(pos, camera.project, camera.position),
      label: 'PREVIEW', color: COLOR_MARKER_ALLY, rotationDeg: 0,
    };
  }

  // フォームの値を検証して初期状態を組み、置く物体を onPlace へ渡す。
  // 検証に落ちるか状態を組めなければ、理由をトーストで知らせて何も渡さない。
  private place(name: string, form: ObjectPlacerForm): void {
    // 隻数の上限が掛かるのは自機だけ(SPEC GAME.md 9.1)。
    if (form.entityKind === 'player' && this.dynamicSystem.all().filter(isPlayer).length >= MAX_PLACED_SHIPS) {
      this.hud.hint(`配置数が上限(${MAX_PLACED_SHIPS}隻)に達しています`);
      return;
    }
    try {
      this.assertValidForm(form);
      const state = this.buildInitialState(form);
      this.assertFiniteEllipticState(state);
      this.onPlace?.(this.createObject(name, form.entityKind, state));
    } catch (error) {
      const message = error instanceof Error ? error.message : '入力を解釈できません';
      this.hud.hint(`配置できません: ${message}`, 5000);
    }
  }

  // 種類ごとに実体を作り、id を採番して、空欄の名前を種類ごとの既定名で埋める。
  private createObject(name: string, entityKind: DynamicEntityKind, state: KinematicState): PlacedObject {
    // 自機は生成引数、それ以外は実体として返す。
    switch (entityKind) {
      case 'player': {
        const id = this.playerIdAllocator.next();
        return { kind: 'player', init: { name: name.trim() || generateRandomName('player'), state, id } };
      }
      case 'enemy': {
        const finalName = name.trim() || generateRandomName('enemy');
        const enemy = generateDriftingEnemy(finalName, state, '#ff6a00', '#ff6a00', this.worldSfx, this.fx, this.scene);
        return { kind: 'entity', entity: enemy, name: enemy.name };
      }
      case 'ammo': {
        const id = this.ammoPickupIdAllocator.next();
        return {
          kind: 'entity',
          entity: new AmmoPickup({ state, id }, this.scene),
          name: name.trim() || generateRandomName('ammo'),
        };
      }
      case 'fuel': {
        const id = this.rcsFuelPickupIdAllocator.next();
        const finalName = name.trim() || generateRandomName('fuel');
        return { kind: 'entity', entity: new RcsFuelPickup({ state, id, name: finalName }, this.scene), name: finalName };
      }
      case 'base': {
        const finalName = name.trim() || generateRandomName('base');
        const base = new Base({ state, name: finalName }, this.scene, this.hud);
        return { kind: 'entity', entity: base, name: base.name };
      }
    }
  }

  // フォームの placementMode に応じて、軌道要素指定かラグランジュ点指定で初期状態を組む。
  private buildInitialState(form: ObjectPlacerForm): KinematicState {
    if (form.placementMode === 'lagrange') return this.buildLagrangeState(form);
    return this.buildElementsState(form);
  }

  // ラグランジュ点まわりのハロー/リサジュー軌道の初期状態を組む。ハローの面内振幅は
  // 三次の振幅拘束で面外振幅から決まるので、フォームに面内振幅の欄がない。
  private buildLagrangeState(form: LagrangeForm): KinematicState {
    const motion = this.celestialSystem.entityOf(form.lagrangeSecondary).motion;
    if (!(motion instanceof OrbitingMotion)) {
      throw new Error(`buildLagrangeState: ${form.lagrangeSecondary} は公転していないのでラグランジュ点を持たない`);
    }
    const t = this.dynamicSystem.simTime;
    const system = secondaryFrameOf(this.celestialSystem.celestialMotions, t, motion, t);
    if (system === null) {
      throw new Error(`buildLagrangeState: ${form.lagrangeSecondary} の主天体が引けない`);
    }
    // 面外振幅 az は両方の軌道種が使い、面内振幅 ax はリサジューだけが持つ。
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
    const centerState = center.stateAt(this.dynamicSystem.simTime);
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

    // 基準天体中心の相対状態を組み、基準天体自身の位置・速度を足して ECI にする。
    const rel = stateFromOrbitalElements(
      this.dynamicSystem.simTime, a, e, form.incDeg * DEG, form.raanDeg * DEG, form.argpDeg * DEG,
      form.nuDeg * DEG, center.def.mu,
    );
    return kinematicState<'eci'>(
      this.dynamicSystem.simTime, add(centerState.r, rel.r), add(centerState.v, rel.v));
  }

  // フォーム値をフィールド単位で検証する。assertValidForm と同じ検証を通し、
  // 入力中の表示と確定時の可否が食い違わないようにする。
  private computeFieldIssues(form: ObjectPlacerForm): PlacementFieldIssue[] {
    // 配置方法によらず効く、種類ごとの基準天体の制約。
    const issues = [...validateBaseReferenceFields(
      form.entityKind, form.placementMode, form.placementMode === 'elements' ? form.celestialBody : undefined,
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
