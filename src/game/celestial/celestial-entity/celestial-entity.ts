// 天体1体。運動(CelestialMotion)と表示名・表示クラスを持ち、見た目(メッシュ・輝点スプライト・
// 環など)をその運動へ同期する。位置・姿勢の正本は motion で、sync のたびにそこから引く。
import * as THREE from 'three/webgpu';
import { CelestialBodyDef, CelestialMotion } from '../../../physics/celestial-motion';
import type { RingSystemDef } from '../../../physics/celestial-body-def';
import { OrbitalElements, orbitalElementsOf } from '../../../physics/elements';
import { KinematicState } from '../../../physics/kinematic-state';
import { EllipseLine } from '../../lines/ellipse-line';
import { LINE_RENDER_ORDER } from '../../../render/line-style';
import type { MarkerManager } from '../../marker/marker-manager';
import { CameraSystem } from '../../camera/camera-system';
import { FloatingOrigin } from '../../camera/floating-origin';
import { apparentSizePx } from '../../../math/projection';
import { SUN_IRRADIANCE_1AU, irradianceAtDistance } from '../../../render/pipeline/sun-light';
import { len, sub } from '../../../math/vec3';
import { bodySearchText } from '../../pickable/body-search-text';
import { MenuCommon, type MenuAction } from '../../hud/windows/menu-actions';
import type { AtmosphereCandidate, AtmosphereOptics } from '../../../render/atmosphere';
import type { Albedo } from '../../../render/celestial-albedo';
import type { CelestialClass } from './celestial-entity-def';
import type { Vec3 } from '../../../math/vec3';
import type { GraphicsSettingsData } from '../../../render/graphics-settings';
import type { SunLight } from '../../../render/pipeline/sun-light';
import type { SunOcclusion } from '../../../render/pipeline/sun-occlusion';
import type { RenderStyle } from '../../../render/render-style';
import type { StarEntity } from './star-entity';
import type { CelestialSystem } from '../celestial-system';
import type { MapPickKind, MapPickable } from '../../pickable/map-pickable';
import type { MapCommands } from '../../pickable/map-commands';
import type { MenuItem } from '../../hud/windows/context-menu';
import type { MapVisibility, MapVisibilityPolicy } from '../../map/visibility-policy';
import type { Player } from '../../player/player';

// 公転天体の参照軌道線の色: 衛星は月軌道線の色、惑星は木星軌道線の色を踏襲し、
// 同じ種別の天体はすべて同じ色で引く。
const SATELLITE_REFERENCE_LINE_COLOR = 0xaab3c0;
const PLANET_REFERENCE_LINE_COLOR = 0xffffff;

// 惑星・衛星の参照軌道線のフェード距離 [m]。カメラから天体までの距離がこれ未満なら非表示、
// FAR 以上なら完全表示、その間は距離に応じて線形にフェードインする。
const PLANET_ORBIT_LINE_FADE_NEAR_DIST = 1e9; // 100万km
const PLANET_ORBIT_LINE_FADE_FAR_DIST = 1e10; // 1000万km
const SATELLITE_ORBIT_LINE_FADE_NEAR_DIST = 5e8; // 50万km
const SATELLITE_ORBIT_LINE_FADE_FAR_DIST = 1e9; // 100万km

// 参照軌道線が完全表示のときの不透明度。
const REFERENCE_LINE_OPACITY = 0.3;

export abstract class CelestialEntity implements MapPickable {
  // マップ専用の参照軌道線(衛星は親惑星中心、惑星は主星中心)。実体も濃さの決め方も個体が
  // 持ち、出す/消すの判断だけを所有者(CelestialSystem)が sync/remove の呼び分けで行う。
  referenceLine: EllipseLine | null = null;

  // atmosphereOptics は大気の見えの光学パラメータ(大気を持たない・描かない天体では null)。
  protected constructor(
    readonly motion: CelestialMotion,
    readonly name: string,
    readonly bodyClass: CelestialClass,
    readonly atmosphereOptics: AtmosphereOptics | null,
  ) {}

  // pivot で厳密に引いた値から時刻 t へ2次外挿した ECI 位置・速度。t を省くと pivot 自身の
  // 厳密な値。|t − pivot| は積分1歩の幅程度に収めること。
  stateAt(pivot: number, t: number = pivot): KinematicState {
    return this.motion.stateAt(pivot, t);
  }

  // この天体を光源として扱うときの色つきアルベド(Rec.709 輝度 = ボンドアルベド)。
  // 自発光の恒星と、測光を持たない表面では null。
  abstract get lightSourceAlbedo(): Albedo | null;

  // 円筒図法の実写テクスチャの URL。単色球・恒星では null。
  abstract get surfaceTextureUrl(): string | null;

  get id(): string {
    return this.motion.id;
  }

  get def(): CelestialBodyDef {
    return this.motion.def;
  }

  // 自分のメッシュ一式を組んでシーンへ登録する。sunOcclusion と sunLight は環が直射散乱の
  // 遮蔽と明るさを引くために要る — 環を持たない天体でも、持ちうる形として受ける。
  abstract build(scene: THREE.Scene, sunOcclusion: SunOcclusion, sunLight: SunLight): void;
  abstract setVisible(visible: boolean): void;
  // star はこの星系の恒星。恒星を持たない星系では null。
  abstract sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, star: StarEntity | null,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void;
  // build(scene) で登録した自分のメッシュ一式をシーンから外し、GPU 資源を解放する。
  // 参照軌道線は所有者が removeReferenceLine で別途解放する。
  abstract dispose(): void;

  // 公転天体の接触軌道要素(表示専用)。衛星は親惑星中心、惑星は主星中心 — 中心天体自身も
  // ECI 上を動くので、固定 CelestialMotion ではなくその時刻の状態を毎回引いて組む。恒星は null。
  referenceElementsAt(t: number): OrbitalElements | null {
    const centerMotion = this.motion.primary;
    if (centerMotion === null) return null;
    return orbitalElementsOf(this.stateAt(t), centerMotion, t);
  }

  // 参照軌道線を表示時刻の接触軌道要素と濃さへ同期する(実体が無ければ生成して scene へ登録)。
  // cameraPos はフェードの濃さを測る基準(カメラの真の ECI 位置)。
  syncReferenceLine(
    scene: THREE.Scene, simTime: number, fo: FloatingOrigin, camera: THREE.Camera, cameraPos: Vec3,
  ): void {
    const opacity = this.referenceLineOpacityFrom(cameraPos, simTime);
    if (this.referenceLine === null) {
      const color = this.motion.kind === 'satellite' ? SATELLITE_REFERENCE_LINE_COLOR : PLANET_REFERENCE_LINE_COLOR;
      this.referenceLine = new EllipseLine({ color, opacity, renderOrder: LINE_RENDER_ORDER.reference });
      scene.add(this.referenceLine.line);
    }
    const elements = this.referenceElementsAt(simTime);
    if (elements === null) this.referenceLine.hide();
    else this.referenceLine.sync(elements, fo, camera);
    this.referenceLine.setOpacity(opacity);
  }

  // cameraPos から見た参照軌道線の不透明度。惑星と衛星でフェード距離が異なる。
  private referenceLineOpacityFrom(cameraPos: Vec3, simTime: number): number {
    const isSatellite = this.motion.kind === 'satellite';
    const nearDist = isSatellite ? SATELLITE_ORBIT_LINE_FADE_NEAR_DIST : PLANET_ORBIT_LINE_FADE_NEAR_DIST;
    const farDist = isSatellite ? SATELLITE_ORBIT_LINE_FADE_FAR_DIST : PLANET_ORBIT_LINE_FADE_FAR_DIST;
    const dist = len(sub(this.stateAt(simTime).r, cameraPos));
    const t = Math.min(1, Math.max(0, (dist - nearDist) / (farDist - nearDist)));
    return t * REFERENCE_LINE_OPACITY;
  }

  // 環(環を持たない天体では null)。どの天体の環の影を落とすかは所有者が選ぶ。
  get rings(): RingSystemDef | null {
    const def = this.def;
    return 'rings' in def ? def.rings ?? null : null;
  }

  // cameraPos から見たこの天体の視半径。影を落としうるか・環をどれで代表させるかの尺度で、
  // 大きく見える天体ほどその影が画面に写っている何かへ落ちる見込みが高い。
  apparentRadiusFrom(cameraPos: Vec3, simTime: number): number {
    const center = this.stateAt(simTime).r;
    return this.def.radius / Math.max(1, len(sub(center, cameraPos)));
  }

  // 大気パスへ渡す1体ぶんの候補。大気を持たない・描かない天体では null。**尺度は直線距離で
  // 引く** — 深度で引くと、視点の背後にある天体が目の前にあるのと同じ尺度になり、画面に
  // 写っていないのに予算を総取りする。
  atmosphereCandidateAt(
    fo: FloatingOrigin, displayTime: number, cameraPos: Vec3, radialScale: (center: Vec3) => number,
  ): AtmosphereCandidate | null {
    const optics = this.atmosphereOptics;
    if (optics === null) return null;
    const center = this.stateAt(displayTime).r;
    return {
      body: { center: fo.RtoThreeV3(center), surfaceRadius: this.def.radius, optics },
      distance: len(sub(cameraPos, center)),
      metersPerPixel: radialScale(center),
    };
  }

  // 参照軌道線を実体ごと解放する。非表示の間も頂点バッファを残さないため。
  removeReferenceLine(): void {
    if (this.referenceLine === null) return;
    this.referenceLine.line.removeFromParent();
    this.referenceLine.dispose();
    this.referenceLine = null;
  }

  // マップ専用の付随表示(静止軌道リングなど)のフック。既定では何も持たない。
  syncMapOverlay(
    _fo: FloatingOrigin, _displayTime: number, _cameraSystem: CameraSystem,
    _markerManager: MarkerManager | null, _celestialBodies: readonly CelestialMotion[], _visible: boolean,
  ): void {}

  // pos が恒星から受けている放射照度(render/pipeline/sun-light.ts の単位)。恒星を持たない
  // 星系では 1 天文単位ぶんを返す — 恒星光を 1 天文単位の位置へ置く CelestialSystem の
  // 扱いと揃える。
  protected sunIrradianceAt(star: StarEntity | null, pos: Vec3, displayTime: number): number {
    if (star === null) return SUN_IRRADIANCE_1AU;
    const d = len(sub(pos, star.stateAt(displayTime).r));
    if (d <= 0) return SUN_IRRADIANCE_1AU;
    return irradianceAtDistance(star.radiantIntensity, d);
  }

  // LOD 段の選択と球体表示の閾値判定が通る見かけ直径 [px]。詳細度の設定はここで掛かる。
  protected lodApparentDiameterPx(
    diameterMeters: number, metersPerPixel: number, graphics: GraphicsSettingsData,
  ): number {
    return apparentSizePx(diameterMeters, metersPerPixel) * graphics.lodBias;
  }

  // マップ上の被選択物としての振る舞い。
  public readonly kind: MapPickKind = 'body';
  public readonly ownerName = null;
  public readonly mapTime = null;
  public readonly gone = false;
  public readonly mapState = null;
  public listPriority(): number { return 0; }
  public listCounted(): boolean { return false; }
  public listDetail(): string { return ''; }

  // 表示時刻の ECI 位置。
  public mapPosAt(displayTime: number): Vec3 {
    return this.stateAt(displayTime).r;
  }

  // 分類・名前トグルによる可否。
  public mapVisibility(policy: MapVisibilityPolicy): MapVisibility {
    return policy.body(this.id);
  }

  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.id); }

  // 一覧の検索が照合する、自艦からの距離と中心天体の名前。
  public listSearchText(
    celestialSystem: CelestialSystem, activePlayer: Player | null, displayTime: number,
  ): string {
    return bodySearchText(celestialSystem, this.mapPosAt(displayTime), activePlayer, displayTime);
  }

  // 右クリックメニュー・プロパティウィンドウに出す操作項目。
  public mapMenuItems(
    commands: MapCommands, celestialSystem: CelestialSystem, simTime: number,
  ): readonly MenuItem<MenuAction>[] {
    const subLabel = this.id === celestialSystem.origin.id ? '母星 (中心天体)'
      : this.id === 'moon' ? '衛星 (月)'
        : this.id === celestialSystem.star?.id ? `恒星 (${this.name})`
          : '天体・ラグランジュ点';
    return [
      { type: 'header', label: this.name, subLabel },
      MenuCommon.focus(),
      ...MenuCommon.targetItems(commands, this.id, simTime),
      MenuCommon.cancel(),
    ];
  }

  // 選ばれた操作を実行する。自分が出していない act では何もしない。
  public runMapMenu(act: MenuAction, commands: MapCommands): void {
    if (act === 'focus') commands.focus(this.id, this.name);
    else if (act === 'target') commands.toggleNavTarget(this.id, this.name);
  }
}
