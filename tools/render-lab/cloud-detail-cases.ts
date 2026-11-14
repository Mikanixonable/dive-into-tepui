// 雲の細部の計測のための撮影。海の上の雲を、実写(衛星写真)と同じ km/px・同じ真下見下ろしで、
// 積雲だけ・巻雲だけ・両方の3種で撮る。巡回の撮影(render-lab:shot)には載せない別口で、
// window.renderLab.cloudDetailShots() が撮影名とメタデータの一覧を、shootCloudDetail() が
// 1 枚の PNG を返す。
import * as THREE from 'three/webgpu';
import { R_EARTH, R_EARTH_EQ, EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { shapeSpheroidRadii } from '../../src/physics/celestial-body-def';
import { metersPerPixelAtDepth, tanHalfFov } from '../../src/math/projection';
import { CUMULUS_DETAIL } from '../../src/render/opaque-cloud-surface-renderer';
import { CIRRUS_DETAIL } from '../../src/render/cloud/cloud-detail';
import { FOV_DEG, labCamera, VIEW_HEIGHT, type LabCase, type LabShot } from './lab-case';
import type { EarthAngleKey, LabViewAngles } from './view-angles';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';

// 直下点に取る海の上の場面。center は tools/cloud-detail/scenes.json(実写の目録)と同じ海域の
// 中心を使うので、撮った画像は同じ場所の実写と同じ物差しで比べられる。
interface CloudDetailScene {
  // 撮影名に使う短い名。
  readonly id: string;
  // 実写の目録(scenes.json)の場面名。
  readonly scene: string;
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
}

const SCENES: readonly CloudDetailScene[] = [
  // 北大西洋貿易風。
  { id: 'natl-trade', scene: 'trade-cumulus-atlantic', latitudeDeg: 15, longitudeDeg: -42 },
  // 南東太平洋の開いた細胞。
  { id: 'sepac-open', scene: 'open-cells-sepacific', latitudeDeg: -20, longitudeDeg: -90 },
  // ペルー沖の閉じた層積雲。
  { id: 'peru-sc', scene: 'closed-stratocumulus-peru', latitudeDeg: -22, longitudeDeg: -82 },
  // 北大西洋の前線帯。
  { id: 'natl-front', scene: 'frontal-band-natlantic', latitudeDeg: 50, longitudeDeg: -35 },
  // 北太平洋ジェットの下の巻雲。
  { id: 'npac-jet', scene: 'jet-cirrus-npacific', latitudeDeg: 42, longitudeDeg: -150 },
  // 西太平洋収束帯のかなとこ雲の流出。
  { id: 'wpac-itcz', scene: 'anvil-cirrus-wpacific', latitudeDeg: 10, longitudeDeg: 150 },
  // 南大洋の寒気流の積雲(高緯度の海)。
  { id: 'south-hl', scene: 'highlat-cumulus-southern', latitudeDeg: -57, longitudeDeg: -120 },
  // ノルウェー海の寒気流の積雲(高緯度の海)。
  { id: 'norw-hl', scene: 'highlat-cumulus-norwegian', latitudeDeg: 68, longitudeDeg: 5 },
  // 西太平洋の冬の寒気流の積雲(温帯の海)。
  { id: 'pac-temp', scene: 'temperate-cumulus-japansea', latitudeDeg: 38, longitudeDeg: 150 },
];

// 段の目標 km/px と表示時刻 [s]。段ごとの高度は海域の緯度ごとに引く(地表の扁平ぶんを
// 高度側で吸収して、画像中心の km/px を目標へ揃える)。
const TIERS_KM_PER_PX = [0.25, 1, 4] as const;
const DISPLAY_TIMES_S = [0, 21600, 43200] as const;

export type CloudDetailKind = 'both' | 'cumulus' | 'cirrus';

// 種類ごとの描画設定の差分。全撮影でレンズ効果は切る — 実写との輝度比較にブルームが混ざらない
// ようにするため。
const KIND_GRAPHICS: Readonly<Record<CloudDetailKind, Partial<GraphicsSettingsData>>> = {
  both: { lens: false },
  cumulus: { lens: false, cirrus: false },
  cirrus: { lens: false, cumulusDetail: CUMULUS_DETAIL.off, translucentCumulus: false },
};

const EARTH_RADII = shapeSpheroidRadii(R_EARTH_EQ, EARTH.shape);

// 直下点の緯度 latitudeDeg で、天体中心から地表までの距離 [m]。楕円体の方向半径。
function surfaceRadiusAt(latitudeDeg: number): number {
  const latitude = THREE.MathUtils.degToRad(latitudeDeg);
  const equator = Math.cos(latitude) / EARTH_RADII.equatorRadius;
  const polar = Math.sin(latitude) / EARTH_RADII.polarRadius;
  return 1 / Math.hypot(equator, polar);
}

// 画像中心の 1 px がちょうど tierKmPerPx km になる描画原点の高度 [m]。直下点の地表までの距離を
// depth = 目標 km/px × 高さ / (2·tan(FOV/2)) とし、地表の扁平ぶんを高度側へ足す。
function altitudeFor(tierKmPerPx: number, latitudeDeg: number): number {
  const depth = (tierKmPerPx * 1000 * VIEW_HEIGHT) / (2 * tanHalfFov(FOV_DEG));
  return depth + surfaceRadiusAt(latitudeDeg) - R_EARTH;
}

// 描画原点の高度 altitudeM・直下点の緯度 latitudeDeg の構図で、画像中心の 1 px が張る実寸 [km]。
// 実際のカメラ(FOV・高さ・位置)から求める。
function centerKmPerPxOf(altitudeM: number, latitudeDeg: number): number {
  const depth = R_EARTH + altitudeM - surfaceRadiusAt(latitudeDeg);
  return metersPerPixelAtDepth(FOV_DEG, depth, VIEW_HEIGHT) / 1000;
}

// ケース既定の地球の置き方: 視線の先(−Z)へ置き、直下点を赤道の経度 0 にする。直下点の真上へ
// カメラが来る真下見下ろし。高度と直下点は撮影ごとに上書きする。
const NADIR_EARTH: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: 180,
  earthElevationDeg: 0,
  earthAltitudeLog: Math.log10(altitudeFor(1, 0)),
  earthLatitudeDeg: 0,
  earthLongitudeDeg: 0,
};

// 恒星の向き。直下点の天頂(描画原点へ向かう向き)から 30° 離す — 低軌道の真下見下ろしで雲の
// 影が出る向き。ずらす方位は画面の上下方向に取る: 天頂角の半分の地表角ぶんずれて落ちる
// サングリントが、最も広い段でも画面の上端の外(水平なら画角の内に残る)へ出るようにする。
const NADIR_SUN_DIRECTION = new THREE.Vector3(0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6));

// 撮影 1 枚ぶんの差分と、そのメタデータ。
export interface CloudDetailShot extends LabShot {
  // 実写の目録(scenes.json)の場面名。
  readonly scene: string;
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  // 表示時刻 [s]。
  readonly displayTime: number;
  readonly kind: CloudDetailKind;
  // 段の目標 km/px。
  readonly tierKmPerPx: number;
  // 実際のカメラで画像中心が張る km/px。扁平と曲率で段の目標からわずかにずれる。
  readonly centerKmPerPx: number;
  // 描画原点の高度 [m]。
  readonly altitudeM: number;
}

// 撮影の表。名前は <海域>-<時刻 h>h-<km/px>km-<種類>(例: npac-jet-6h-1km-cirrus)、
// 総数は 6 海域 × 3 時刻 × 3 段 × 3 種類 = 162。
export const CLOUD_DETAIL_SHOTS: Readonly<Record<string, CloudDetailShot>> = (() => {
  const shots: Record<string, CloudDetailShot> = {};
  for (const scene of SCENES) {
    for (const displayTime of DISPLAY_TIMES_S) {
      for (const tierKmPerPx of TIERS_KM_PER_PX) {
        const altitudeM = altitudeFor(tierKmPerPx, scene.latitudeDeg);
        const view: Partial<LabViewAngles> = {
          earthAltitudeLog: Math.log10(altitudeM),
          earthLatitudeDeg: scene.latitudeDeg,
          earthLongitudeDeg: scene.longitudeDeg,
        };
        for (const kind of Object.keys(KIND_GRAPHICS) as CloudDetailKind[]) {
          const name = `${scene.id}-${displayTime / 3600}h-${tierKmPerPx}km-${kind}`;
          shots[name] = {
            scene: scene.scene,
            latitudeDeg: scene.latitudeDeg,
            longitudeDeg: scene.longitudeDeg,
            displayTime,
            kind,
            tierKmPerPx,
            centerKmPerPx: centerKmPerPxOf(altitudeM, scene.latitudeDeg),
            altitudeM,
            view,
            graphics: KIND_GRAPHICS[kind],
          };
        }
      }
    }
  }
  return shots;
})();

// cloudDetailShots() が返す 1 撮影ぶんのメタデータ。
export interface CloudDetailShotInfo {
  readonly name: string;
  readonly scene: string;
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  readonly displayTime: number;
  readonly kind: CloudDetailKind;
  readonly tierKmPerPx: number;
  readonly centerKmPerPx: number;
  readonly altitudeM: number;
}

export const CLOUD_DETAIL_SHOT_INFOS: readonly CloudDetailShotInfo[] =
  Object.entries(CLOUD_DETAIL_SHOTS).map(([name, shot]) => ({
    name,
    scene: shot.scene,
    latitudeDeg: shot.latitudeDeg,
    longitudeDeg: shot.longitudeDeg,
    displayTime: shot.displayTime,
    kind: shot.kind,
    tierKmPerPx: shot.tierKmPerPx,
    centerKmPerPx: shot.centerKmPerPx,
    altitudeM: shot.altitudeM,
  }));

// 巻雲の精細さ「粗」の撮影。標準の巻雲の撮影と同じ構図で、細部だけを切る。標準と比べて濃さの
// 平均が変わらないことを確かめるための組で、計測の一覧(CLOUD_DETAIL_SHOT_INFOS)には載せない。
// 撮影名は標準の撮影名に -coarse を足したもの。
export const CLOUD_DETAIL_CIRRUS_COARSE_SHOTS: Readonly<Record<string, CloudDetailShot>> = Object.fromEntries(
  Object.entries(CLOUD_DETAIL_SHOTS)
    .filter(([, shot]) => shot.kind === 'cirrus')
    .map(([name, shot]) => [`${name}-coarse`, {
      ...shot, graphics: { ...shot.graphics, cirrusDetail: CIRRUS_DETAIL.coarse },
    }]),
);

// 巻雲の筋の影が太陽の向きに沿うかを、近くで見るための撮影。sepac-open の 12 時・0.25 km/px で巻雲だけを描き、
// 太陽は表面の天頂から 70 度(高度 20 度)へ置く。計測の一覧(CLOUD_DETAIL_SHOT_INFOS)には載せない。
const LOWSUN_BASE = CLOUD_DETAIL_SHOTS['sepac-open-12h-0.25km-cirrus'];
if (LOWSUN_BASE === undefined) throw new Error('sepac-open-12h-0.25km-cirrus が無い');
export const CLOUD_DETAIL_CHECK_SHOTS: Readonly<Record<string, CloudDetailShot>> = {
  'sepac-open-lowsun-12h-0.25km-cirrus': {
    ...LOWSUN_BASE, view: { ...LOWSUN_BASE.view, sunAzimuthDeg: 70, sunElevationDeg: 0 },
  },
};

// 視点を動かしただけで雲の形が変わらないかと、時間とともにどう流れ入れ替わるかを測る撮影の組。同じ場面を、
// 基準(base)・直下点を北へ STABILITY_SHIFT_PX 画素ぶんずらした構図(shift)・高度を STABILITY_ZOOM 倍にした
// 構図(zoom)・同じ構図の 10 分後(later10)と 30 分後(later30)で撮る。止まった雲なら、位置と縮尺を合わせた
// 基準・shift・zoom は一致する。base・later10・later30 は種類ごと(両方・積雲だけ・巻雲だけ)にも撮る —
// 層ごとに風が違うので、時間の計測を層別の位置合わせで読めるようにするため。計測の一覧
// (CLOUD_DETAIL_SHOT_INFOS)には載せない。
// 撮影名は <海域>-<時刻 h>h-<km/px>km-stab-<base|shift|zoom|later10|later30>。
// 積雲だけ・巻雲だけは末尾へ -cumulus / -cirrus を足す(種類の無標は両方)。
const STABILITY_SCENE_IDS = ['natl-front', 'npac-jet', 'pac-temp', 'south-hl', 'wpac-itcz'] as const;
const STABILITY_DISPLAY_TIME_S = 21600;
// ずらす画素数。cap の 1 texel(低軌道で約 10 km)より短く、細部の段(0.25 km/px で 1〜32 px)を跨ぐ長さ。
const STABILITY_SHIFT_PX = 6;
// 高度の倍率。cap の半径と細部の段の減衰の両方が動く幅。
const STABILITY_ZOOM = 1.25;
export type CloudDetailStabilityVariant = 'base' | 'shift' | 'zoom' | 'later10' | 'later30';

export const CLOUD_DETAIL_STABILITY_SHOTS: Readonly<Record<string, CloudDetailShot>> = (() => {
  const shots: Record<string, CloudDetailShot> = {};
  for (const id of STABILITY_SCENE_IDS) {
    const scene = SCENES.find((entry) => entry.id === id);
    if (scene === undefined) throw new Error(`stability: no scene ${id}`);
    for (const tierKmPerPx of TIERS_KM_PER_PX) {
      const baseAltitude = altitudeFor(tierKmPerPx, scene.latitudeDeg);
      const shiftDeg = THREE.MathUtils.radToDeg(
        (STABILITY_SHIFT_PX * tierKmPerPx * 1000) / surfaceRadiusAt(scene.latitudeDeg));
      const variants: Record<
        CloudDetailStabilityVariant, { altitudeM: number; latitudeDeg: number; laterS: number }
      > = {
        base: { altitudeM: baseAltitude, latitudeDeg: scene.latitudeDeg, laterS: 0 },
        shift: { altitudeM: baseAltitude, latitudeDeg: scene.latitudeDeg + shiftDeg, laterS: 0 },
        zoom: { altitudeM: baseAltitude * STABILITY_ZOOM, latitudeDeg: scene.latitudeDeg, laterS: 0 },
        later10: { altitudeM: baseAltitude, latitudeDeg: scene.latitudeDeg, laterS: 600 },
        later30: { altitudeM: baseAltitude, latitudeDeg: scene.latitudeDeg, laterS: 1800 },
      };
      for (const [variant, placement] of Object.entries(variants)) {
        const stem = `${scene.id}-${STABILITY_DISPLAY_TIME_S / 3600}h-${tierKmPerPx}km-stab-${variant}`;
        // 視点の安定性を見る構図(shift / zoom)は両方だけ。時間の計測に使う構図は層別にも撮る。
        const kinds: readonly CloudDetailKind[] =
          variant === 'shift' || variant === 'zoom' ? ['both'] : ['both', 'cumulus', 'cirrus'];
        for (const kind of kinds) {
          shots[kind === 'both' ? stem : `${stem}-${kind}`] = {
            scene: scene.scene,
            latitudeDeg: placement.latitudeDeg,
            longitudeDeg: scene.longitudeDeg,
            displayTime: STABILITY_DISPLAY_TIME_S + placement.laterS,
            kind,
            tierKmPerPx,
            centerKmPerPx: centerKmPerPxOf(placement.altitudeM, placement.latitudeDeg),
            altitudeM: placement.altitudeM,
            view: {
              earthAltitudeLog: Math.log10(placement.altitudeM),
              earthLatitudeDeg: placement.latitudeDeg,
              earthLongitudeDeg: scene.longitudeDeg,
            },
            graphics: KIND_GRAPHICS[kind],
          };
        }
      }
    }
  }
  return shots;
})();

export const CLOUD_DETAIL_STABILITY_SHOT_INFOS: readonly CloudDetailShotInfo[] =
  Object.entries(CLOUD_DETAIL_STABILITY_SHOTS).map(([name, shot]) => ({
    name,
    scene: shot.scene,
    latitudeDeg: shot.latitudeDeg,
    longitudeDeg: shot.longitudeDeg,
    displayTime: shot.displayTime,
    kind: shot.kind,
    tierKmPerPx: shot.tierKmPerPx,
    centerKmPerPx: shot.centerKmPerPx,
    altitudeM: shot.altitudeM,
  }));

// 雲の細部の撮影が共有するケース。地球だけを置き、カメラは描画原点から直下点の地表を見る。
// 観察の向きと描画設定は撮影ごとの差分で決まる。巡回のケースには登録しない。
export function cloudDetailCase(): LabCase {
  return {
    objects: [],
    camera: labCamera(),
    // 注視点は視線上の任意の深さでよい — カメラは描画原点に留まり、深さは撮影の高度で決まる。
    viewTarget: new THREE.Vector3(0, 0, -altitudeFor(1, 0)),
    sunDirection: NADIR_SUN_DIRECTION,
    earth: NADIR_EARTH,
    shots: {
      ...CLOUD_DETAIL_SHOTS, ...CLOUD_DETAIL_CIRRUS_COARSE_SHOTS, ...CLOUD_DETAIL_CHECK_SHOTS,
      ...CLOUD_DETAIL_STABILITY_SHOTS,
    },
  };
}
