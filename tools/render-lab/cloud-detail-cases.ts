// 雲の細部の計測のための撮影。海の上の雲を、実写(衛星写真)と同じ km/px・同じ真下見下ろしで、
// 積雲だけ・巻雲だけ・両方の3種で撮る。巡回の撮影(render-lab:shot)には載せない別口で、
// window.renderLab.cloudDetailShots() が撮影名とメタデータの一覧を、shootCloudDetail() が
// 1 枚の PNG を返す。
import * as THREE from 'three/webgpu';
import { R_EARTH, R_EARTH_EQ, EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { shapeSpheroidRadii } from '../../src/physics/celestial-body-def';
import { metersPerPixelAtDepth, tanHalfFov } from '../../src/math/projection';
import { CUMULUS_DETAIL } from '../../src/render/opaque-cloud-surface-renderer';
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
    shots: CLOUD_DETAIL_SHOTS,
  };
}
