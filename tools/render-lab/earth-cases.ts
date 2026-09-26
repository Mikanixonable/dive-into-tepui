// 地球まわりのケース。地球照を受ける自機と板・地平線の地球・火星との構図ごとに、観察のつまみで置く
// 地球の既定の置き方と、置き方を変えた撮影を宣言し、その地球に合わせて自機・板・試験球・火星を置く。
import * as THREE from 'three/webgpu';
import { R_EARTH, R_EARTH_EQ } from '../../src/game/celestial/solar-system/earth-system';
import { shapeSpheroidRadii } from '../../src/physics/celestial-body-def';
import { Curve } from '../../src/render/curve';
import { markLitOpaque } from '../../src/render/pipeline/lit-layer';
import { sphereShadowBody } from '../../src/render/pipeline/shadow/body-shadow';
import { MARS, MARS_ATMOSPHERE_OPTICS, MARS_TEXTURE } from '../../src/game/celestial/solar-system/mars-system';
import { LINE_RENDER_ORDER, type LineStyle } from '../../src/render/line-style';
import { ATMOSPHERE_QUALITY } from '../../src/render/atmosphere';
import { anglesFromDirection, directionFromAngles, type EarthAngleKey, type LabViewAngles } from './view-angles';
import { earthCenterOf } from './lab-earth';
import {
  AHEAD, circleSampler, CLOSE_UP_DIAMETER_PX, FOV_DEG, GREY_SPHERE_ALBEDO, labCamera, MAX_CAMERA_DISTANCE_LOG,
  SHIP_ROTATION_PORT, shipAt, sphere, SUN_DIR_ANGLES, sunAnglesOf, texturedBody, VIEW_HEIGHT,
  type CaseBuilder, type LabCase,
} from './lab-case';

// THREE.PlaneGeometry の面が向くローカルの向き。
const PLATE_LOCAL_NORMAL = new THREE.Vector3(0, 0, 1);

// 一辺 size [m] の白い正方形の板を、中心 center(描画座標)・法線 normal・粗さ roughness・
// 金属度 metalness で置く。
function whitePlate(
  size: number, center: THREE.Vector3, normal: THREE.Vector3, roughness: number, metalness: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness, metalness }),
  );
  mesh.position.copy(center);
  mesh.quaternion.setFromUnitVectors(PLATE_LOCAL_NORMAL, normal);
  // ジオメトリとマテリアルはケースが所有し、板は照明を受ける不透明物として描く。
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  markLitOpaque(mesh);
  return mesh;
}

// 低軌道の高度 [m]。視半径が 69.7° あるので、地球を真正面へ置くと画面を埋める。
const LEO_ALTITUDE = 420e3;

// 低軌道のケースの地球の置き方: 描画原点の真下に置き、直下点をサハラ(北緯 23°・東経 13°)にする。
const LEO_PLACEMENT: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: 180,
  earthElevationDeg: -90,
  earthAltitudeLog: Math.log10(LEO_ALTITUDE),
  earthLatitudeDeg: 23,
  earthLongitudeDeg: 13,
};

// 低軌道のケースで自機と板を置く位置(描画座標)。自機はカメラより少し上へ置いて下面が見える
// ようにし、板は恒星が真上でも自機の影に入らないよう、自機の右へ離す。金属板は拡散板の真下の、
// 地平線とのあいだへ並べる。
const LEO_SHIP_POSITION = new THREE.Vector3(-5, 3, -30);
const LEO_DIFFUSE_PLATE_CENTER = new THREE.Vector3(9, 0, -26);
const LEO_METAL_PLATE_CENTER = new THREE.Vector3(9, -6.5, -26);
// 板の法線と一辺 [m]。法線は真下の地球を向きつつ、面がカメラからも見える向きへ傾けてある。
const LEO_PLATE_NORMAL = new THREE.Vector3(0, -0.7, 0.7).normalize();
const LEO_PLATE_SIZE = 8;
// 自機の軌道の線の見た目。
const LEO_ORBIT_STYLE: LineStyle = { color: 0x6fd3ff, opacity: 0.9, renderOrder: LINE_RENDER_ORDER.shipOrbit };

// 三日月の撮影の描画原点の高度 [m]。天体照は受け手から見えている地表の日照で決まるので、位相角 φ の
// 三日月から光が届くには、可視キャップの半角 acos(R/d) が φ − 90° を超える必要がある。中心距離
// 1.5 地球半径では 48.2° あり、位相角 120° が要求する 30° を超える。
const CRESCENT_ALTITUDE = 0.5 * R_EARTH;

// 三日月の撮影の地球と恒星の置き方。地球は描画原点の真下に置いて直下点を北極にし、恒星は位相角
// 120°(地球から見た恒星と自機のなす角)の三日月になる向きへ置く。
const CRESCENT_VIEW: Partial<LabViewAngles> = {
  earthAzimuthDeg: 0,
  earthElevationDeg: -90,
  earthAltitudeLog: Math.log10(CRESCENT_ALTITUDE),
  earthLatitudeDeg: 90,
  earthLongitudeDeg: 180,
  ...sunAnglesOf(new THREE.Vector3(Math.sin((2 * Math.PI) / 3), Math.cos((2 * Math.PI) / 3), 0)),
};

// 遠い天体照の撮影の地球の向き。既定のカメラ(描画原点)から金属板の中心を見る向きを、板の法線で
// 反射した向き — 金属板は中心に地球を映し、同じ法線の拡散板も地球への余弦を残す。
const PLANETSHINE_EARTH_DIR = LEO_METAL_PLATE_CENTER.clone().normalize().reflect(LEO_PLATE_NORMAL);
const PLANETSHINE_EARTH_ANGLES = anglesFromDirection(PLANETSHINE_EARTH_DIR);
// 月軌道相当の視半径(0.95°)になる地球の中心距離 [m]。
const PLANETSHINE_EARTH_DISTANCE = R_EARTH / Math.sin(THREE.MathUtils.degToRad(0.95));
// 遠い天体照の撮影の地球と恒星の置き方。直下点は赤道上(東経 127°)に取り、両極を円盤の縁へ置く。
// 恒星は地球のちょうど反対 — 板の裏から差すので、板に直射は1本も届かない。
const PLANETSHINE_VIEW: Partial<LabViewAngles> = {
  earthAzimuthDeg: PLANETSHINE_EARTH_ANGLES.azimuthDeg,
  earthElevationDeg: PLANETSHINE_EARTH_ANGLES.elevationDeg,
  earthAltitudeLog: Math.log10(PLANETSHINE_EARTH_DISTANCE - R_EARTH),
  earthLatitudeDeg: 0,
  earthLongitudeDeg: 127,
  ...sunAnglesOf(PLANETSHINE_EARTH_DIR.clone().negate()),
};

// 地球低軌道: 直下がサハラの実写の地球の上に、自機・白い拡散板と金属板・自機の円軌道を置く。視線は
// 軌道の接線方向なので、地平線と、そこへ伸びていく自分の軌道が入る。
function leo(): LabCase {
  const camera = labCamera();
  const orbit = new Curve(LEO_ORBIT_STYLE);
  return {
    objects: [
      shipAt(LEO_SHIP_POSITION, SHIP_ROTATION_PORT),
      whitePlate(LEO_PLATE_SIZE, LEO_DIFFUSE_PLATE_CENTER, LEO_PLATE_NORMAL, 1, 0),
      whitePlate(LEO_PLATE_SIZE, LEO_METAL_PLATE_CENTER, LEO_PLATE_NORMAL, 0.05, 1),
      orbit.object,
    ],
    camera,
    viewTarget: LEO_SHIP_POSITION,
    earth: LEO_PLACEMENT,
    // 自機の軌道は、地球の中心と自機を通り、視線の先(−Z)へ伸びる円。地球はつまみで動くので、
    // 毎フレームその中心から引き直す。
    sync: (_graphics, earthCenter) => {
      // 地球を置くケースなので、中心は必ず渡る。
      const center = earthCenter!;
      const toShip = new THREE.Vector3().subVectors(LEO_SHIP_POSITION, center);
      const radius = toShip.length();
      const u = toShip.normalize();
      const v = AHEAD.clone().projectOnPlane(u).normalize();
      orbit.setAnalyticCurve(circleSampler(center, radius, u, v), camera, VIEW_HEIGHT);
    },
    shots: {
      // 軌道の線が自機と地球(地平線)に正しく隠れるかと、自機の陰影を見る。
      'leo': { view: {} },
      // 地球照。恒星は真上から差すので、自機の上面だけが直射を受け、下面と板は地球照だけで照らされる。
      // **板の色は直下のサハラの地表の色で決まる。** 横を向いた面はどちらの光も受けず桁で暗い。
      'earthshine': { view: { sunElevationDeg: 90 } },
      // 三日月。真下の地球が位相角 120° の三日月になり、その地球照が自機の下面を照らす。恒星は水平から
      // 30° 下にあるので、下面のうち直射を受けない側が地球照だけで照らされる。
      'crescent': { view: CRESCENT_VIEW },
      // 遠い天体照。月軌道相当の距離に置いた地球だけが板を照らし、**板に出る明るさを天体照だけで
      // 決める。** 画素値を厳密に比べる撮影なので、撮り直しのたびに値が揺れる半影の源になる大気と雲は
      // 描画設定で構図から外す。
      'planetshine-far': {
        view: PLANETSHINE_VIEW,
        graphics: { atmosphere: ATMOSPHERE_QUALITY.off, clouds: false },
      },
    },
  };
}

// 地球のケースで食を起こす球: 地表のどこへ影を落とすか(直下からの中心角 [rad])と、その球の半径・
// 距離。距離に対する半径の比を太陽の視半径(4.65e-3)よりわずかに大きく取ると、本影を半影が
// 縁取る金環直前の配置になる。
const ECLIPSE_GROUND_ANGLE = 0.25;
const ECLIPSE_SHADOW_BODY_RADIUS = 2e5;
const ECLIPSE_SHADOW_BODY_DISTANCE = 3e7;

// 高度 altitude [m] の描画原点から見て、地球の地平線が視線(−Z)から margin [rad] だけ下へ来る
// 置き方。直下点は経度 0 の子午線上の、天体固定の軸を描画座標の軸へ揃える緯度に取る。
function placementBelowHorizon(altitude: number, margin: number): Pick<LabViewAngles, EarthAngleKey> {
  const tiltDeg = THREE.MathUtils.radToDeg(Math.asin(R_EARTH / (R_EARTH + altitude)) + margin);
  return {
    earthAzimuthDeg: 180,
    earthElevationDeg: -tiltDeg,
    earthAltitudeLog: Math.log10(altitude),
    earthLatitudeDeg: tiltDeg,
    earthLongitudeDeg: 0,
  };
}

// 地球のケースの地球の置き方と、その中心(描画座標)。
const EARTH_PLACEMENT = placementBelowHorizon(LEO_ALTITUDE, 0);
const EARTH_CENTER = earthCenterOf(EARTH_PLACEMENT);
const EARTH_VIEW_TARGET = new THREE.Vector3(0, 0, EARTH_CENTER.z);
const EARTH_VIEW_TARGET_DEPTH = -EARTH_VIEW_TARGET.z;

// 赤道面の地表をケースの固定 pivot へ重ねる地球配置。
const EARTH_NADIR_PLACEMENT: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: 180,
  earthElevationDeg: 0,
  earthAltitudeLog: Math.log10(EARTH_VIEW_TARGET_DEPTH + R_EARTH_EQ - R_EARTH),
  earthLatitudeDeg: 0,
  earthLongitudeDeg: 0,
};
const EARTH_LOW_ORBIT_ALTITUDE_M = 120e3;
const EARTH_LOW_ORBIT_PLACEMENT = placementBelowHorizon(EARTH_LOW_ORBIT_ALTITUDE_M, 0);
// 昼夜境界の撮影の恒星の向き。視線の先の地平線上。
const EARTH_TERMINATOR_SUN = sunAnglesOf(AHEAD.clone().projectOnPlane(EARTH_CENTER.clone().negate().normalize()));
const EARTH_LOW_SUN_ELEVATION_DEG = 8;
const EARTH_VISIBLE_SURFACE_NORMAL = EARTH_CENTER.clone().negate().normalize();
const EARTH_LOW_SUN_TANGENT = AHEAD.clone().projectOnPlane(EARTH_VISIBLE_SURFACE_NORMAL).normalize();
const EARTH_LOW_SUN = sunAnglesOf(
  EARTH_LOW_SUN_TANGENT.multiplyScalar(Math.cos(THREE.MathUtils.degToRad(EARTH_LOW_SUN_ELEVATION_DEG)))
    .addScaledVector(EARTH_VISIBLE_SURFACE_NORMAL, Math.sin(THREE.MathUtils.degToRad(EARTH_LOW_SUN_ELEVATION_DEG))),
);
// 日食の撮影の恒星の向き。食を起こす球はこの向きへ置くので、既定の向き(SUN_DIR)の撮影では影の軸が
// 地表点から約 5,000 km(3e7 m × sin 9.5°)外れ、地平線まで(地表距離 約 2,300 km)に斑(半影の
// 半径 約 340 km)は入らない。地球の置き方を変える撮影(斜視・極)では、影の軸は描画原点から見えない
// 側へ落ちるか、地球を外れる。
const EARTH_ECLIPSE_SUN = {
  ...SUN_DIR_ANGLES,
  sunAzimuthDeg: SUN_DIR_ANGLES.sunAzimuthDeg + 10,
};

// 大気の外に置く試験球の半径 [m] と中心(描画座標)。カメラと同じ高度帯(403km)に居るので、
// **カメラとの間に大気が無く、地表と違って霞んではならない。** 地平線を背にした輪郭で読む。中心は
// 50km 先の、視線を描画原点の鉛直(地球の中心の向き)まわりに右へ 30° 回した向き — 地平線に接した
// まま、斜視・極の撮影の中央を空け、極の撮影では地球の円盤(視半径 20°)の外へ出る。
const ABOVE_ATMOSPHERE_RADIUS = 1e3;
const ABOVE_ATMOSPHERE_CENTER = AHEAD.clone()
  .applyAxisAngle(EARTH_CENTER.clone().normalize(), THREE.MathUtils.degToRad(30))
  .multiplyScalar(5e4);

// 斜視の撮影の、地平線を視線から下げる角 [rad]。負なので地平線は視線の上へ来る — 画面中央の地表を
// 入射角およそ 45° で見下ろす向き。
const EARTH_OBLIQUE_MARGIN = -0.49;
const EARTH_OBLIQUE_PLACEMENT = placementBelowHorizon(LEO_ALTITUDE, EARTH_OBLIQUE_MARGIN);

// 極の撮影の地球の視直径が画面の高さに占める割合と、恒星の向き。恒星は極を斜め上から照らす向きへ
// 置き、雲の影が極域いっぱいに伸びるようにする。
const EARTH_POLAR_SCREEN_FRACTION = 0.8;
const EARTH_POLAR_SUN = sunAnglesOf(new THREE.Vector3(1, 0, 1));
// 極の撮影の地球の視半径 [rad]。
const EARTH_POLAR_APPARENT_RADIUS = THREE.MathUtils.degToRad(FOV_DEG / 2) * EARTH_POLAR_SCREEN_FRACTION;
// 極の撮影の地球の置き方: 視線の先(−Z)に置き、北極を描画原点へ向ける。
const EARTH_POLAR_PLACEMENT: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: 180,
  earthElevationDeg: 0,
  earthAltitudeLog: Math.log10(R_EARTH / Math.sin(EARTH_POLAR_APPARENT_RADIUS) - R_EARTH),
  earthLatitudeDeg: 90,
  earthLongitudeDeg: 0,
};

// 地球: 描画原点から −Z を見て、地球の置き方を撮影ごとに変える。既定は低軌道の高度から地平線方向を
// 見る構図で、大気のリムと地表のもや、大気の外に居る物体を見る。日食の撮影の恒星の方向には、食を
// 起こす球を影の源として置く(画面には写らない)。
function earth(): LabCase {
  // 食を起こす球が影を落とす地表点。カメラ直下と地平線(地表距離 2,255km)の中間へ来るよう、
  // 直下の向きを視線側へ回す。
  const groundDir = EARTH_CENTER.clone().negate().normalize()
    .applyAxisAngle(new THREE.Vector3(1, 0, 0), -ECLIPSE_GROUND_ANGLE);
  const ground = EARTH_CENTER.clone().addScaledVector(groundDir, R_EARTH);
  const eclipseSunDirection = directionFromAngles(
    EARTH_ECLIPSE_SUN.sunAzimuthDeg, EARTH_ECLIPSE_SUN.sunElevationDeg, new THREE.Vector3(),
  );
  const eclipseBodyCenter = ground.clone().addScaledVector(eclipseSunDirection, ECLIPSE_SHADOW_BODY_DISTANCE);
  return {
    objects: [sphere(GREY_SPHERE_ALBEDO, ABOVE_ATMOSPHERE_RADIUS, ABOVE_ATMOSPHERE_CENTER)],
    camera: labCamera(),
    viewTarget: EARTH_VIEW_TARGET,
    earth: EARTH_PLACEMENT,
    shadowBodies: [sphereShadowBody(eclipseBodyCenter, ECLIPSE_SHADOW_BODY_RADIUS)],
    shots: {
      'earth': { view: {} },
      'earth-nadir': { view: EARTH_NADIR_PLACEMENT },
      // サングリント。恒星をカメラのほぼ背後(方位 0)に置き、直下点の水域へ太陽の円盤の鏡面
      // 反射が乗る構図。滑らかな水面ではグリントの縁がメッシュ分割や地形標本の格子上で
      // 折れてはならない。
      'earth-glint': { view: { ...EARTH_NADIR_PLACEMENT, ...sunAnglesOf(new THREE.Vector3(0, 0.3, 1)) } },
      'earth-low-orbit': { view: EARTH_LOW_ORBIT_PLACEMENT },
      'earth-limb': { view: {} },
      // 昼夜境界。**太陽光が最も長く大気を通って届く向き**なので、波長ごとの減衰だけで縁と霞が橙へ
      // 寄っていなければならない。前方散乱が効く向きでもあるので、太陽のまわりのグローもここで読む。
      'earth-terminator': { view: EARTH_TERMINATOR_SUN },
      'earth-twilight': { view: EARTH_TERMINATOR_SUN },
      'earth-low-sun': { view: EARTH_LOW_SUN },
      // 日食。**大気の明暗は入射角だけでなく影の濃さにも比例する**ので、リムともやの両方へ影の落ちた
      // 斑が出る。斑は本影(半径 60km)を半影(340km)が縁取る。
      'earth-eclipse': { view: EARTH_ECLIPSE_SUN },
      // カメラが周回の中心(地球の中心)の反対側へ回り、直下点が元から 40° 離れた位置から地平線を見る。
      // **雲場の cap はカメラの直下点へ追従する**ので、ここでも手前の地表に雲が出なければならない。
      'earth-camera-orbit': { view: { cameraAzimuthDeg: 180 } },
      // 斜視。地平線を視線より上げて地表を斜めに見下ろす。**積雲の塔を真上からでも真横からでもなく
      // 見る向き**なので、雲頂の起伏と塔の側面はここで読む。
      'earth-oblique': { view: EARTH_OBLIQUE_PLACEMENT },
      // 極。自転軸をカメラへ向け、北極を中心に見下ろす。**正距円筒の場は極で経度が 1 点へ集まる**ので、
      // 場の引き方の破綻はこの構図に出る。
      'earth-polar': { view: { ...EARTH_POLAR_PLACEMENT, ...EARTH_POLAR_SUN } },
      // 極の昼夜境界。恒星を視線と直交させ、昼夜境界を極の上へ通す。**扁平な天体でも影は地平線
      // どおりに落ちる** — 境界は半影ぶんに滑らかで、緯度によらない直線の縁は出ない。天体自身が影を
      // 落とす側に載っていて、地表も雲頂も低い高度の大気も、その内側ではなく表面より外に居ることを
      // ここで読む。
      'earth-polar-terminator': {
        view: { ...EARTH_POLAR_PLACEMENT, ...sunAnglesOf(new THREE.Vector3(1, 0, 0)) },
      },
    },
  };
}

// 地球と火星のケースの寸法 [m]。**距離のつまみを縮め切った位置が火星の大気の中**へ来るよう、
// 火星までの距離を到達高度から逆算する。カメラの高度は地球の大気の裾(高度 116km)の内側。
const MARS_RADIUS = MARS.radius;
const MARS_ARRIVAL_ALTITUDE = 4e4;
const EARTH_MARS_DISTANCE = (MARS_RADIUS + MARS_ARRIVAL_ALTITUDE) * 10 ** MAX_CAMERA_DISTANCE_LOG;
const EARTH_MARS_CAMERA_ALTITUDE = 1e5;
// 火星の円盤の中心を地球の地平線から持ち上げる角の、火星の視半径に対する倍率。
const EARTH_MARS_HORIZON_CLEARANCE = 1.25;
const EARTH_MARS_PLACEMENT = placementBelowHorizon(
  EARTH_MARS_CAMERA_ALTITUDE, EARTH_MARS_HORIZON_CLEARANCE * Math.asin(MARS_RADIUS / EARTH_MARS_DISTANCE),
);

// 地球と火星: 大気を持つ天体が2体ある構図。カメラは地球の大気の中から、地平線のすぐ上へ出た
// 火星を見る。**火星の円盤は下縁ほど厚い地球の大気越しに見える**ので、主天体の大気の下で遠くの
// 大気天体がどう保たれるかが1枚の中の階調として出る。距離のつまみを縮めていくと、途中で主天体が
// 入れ替わる。
function earthMars(): LabCase {
  const marsCenter = new THREE.Vector3(0, 0, -EARTH_MARS_DISTANCE);
  const mars = texturedBody(MARS_TEXTURE, MARS, marsCenter, CLOSE_UP_DIAMETER_PX);
  const marsRadii = shapeSpheroidRadii(MARS.radius, MARS.shape);
  return {
    objects: [mars.object],
    camera: labCamera(),
    viewTarget: marsCenter,
    earth: EARTH_MARS_PLACEMENT,
    atmospheres: [
      // 火星の大気の地表は、本体と同じ定義の扁平に採る。
      {
        center: marsCenter,
        surfaceRadius: marsRadii.equatorRadius,
        polarAxis: new THREE.Vector3(0, 1, 0),
        polarRatio: marsRadii.polarRadius / marsRadii.equatorRadius,
        optics: MARS_ATMOSPHERE_OPTICS,
        clouds: null,
      },
    ],
    ready: mars.ready,
  };
}

export const EARTH_CASES = {
  'leo': leo,
  'earth': earth,
  'earth-mars': earthMars,
} as const satisfies Record<string, CaseBuilder>;
