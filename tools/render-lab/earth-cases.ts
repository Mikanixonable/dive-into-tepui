// 地球まわりのケース。低軌道・三日月・遠い天体照・地平線・斜視・極・火星との構図ごとに、観察の
// つまみで置く地球の既定の置き方を宣言し、その地球に合わせて自機・板・試験球・火星を置く。
import * as THREE from 'three/webgpu';
import { R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
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

// 低軌道のケースで自機と拡散板を置く位置(描画座標)。自機はカメラより少し上へ置いて下面が見える
// ようにし、板は恒星が真上でも自機の影に入らないよう、自機の右へ離す。
const LEO_SHIP_POSITION = new THREE.Vector3(-5, 3, -30);
const LEO_PLATE_CENTER = new THREE.Vector3(9, 0, -26);
// 拡散板の法線と一辺 [m]。法線は真下の地球を向きつつ、面がカメラからも見える向きへ傾けてある。
const LEO_PLATE_NORMAL = new THREE.Vector3(0, -0.7, 0.7).normalize();
const LEO_PLATE_SIZE = 8;
// 自機の軌道の線の見た目。
const LEO_ORBIT_STYLE: LineStyle = { color: 0x6fd3ff, opacity: 0.9, renderOrder: LINE_RENDER_ORDER.shipOrbit };

// 地球低軌道: 直下がサハラの実写の地球の上に、自機・白い拡散板・自機の円軌道を置く。視線は軌道の
// 接線方向なので、地平線と、そこへ伸びていく自分の軌道が入る。
function leo(): LabCase {
  const camera = labCamera();
  const orbit = new Curve(LEO_ORBIT_STYLE);
  return {
    objects: [
      shipAt(LEO_SHIP_POSITION, SHIP_ROTATION_PORT),
      whitePlate(LEO_PLATE_SIZE, LEO_PLATE_CENTER, LEO_PLATE_NORMAL, 1, 0),
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
    },
  };
}

// 三日月のケースの描画原点の高度 [m]。天体照は受け手から見えている地表の日照で決まるので、位相角 φ の
// 三日月から光が届くには、可視キャップの半角 acos(R/d) が φ − 90° を超える必要がある。中心距離
// 1.5 地球半径では 48.2° あり、位相角 120° が要求する 30° を超える。
const CRESCENT_ALTITUDE = 0.5 * R_EARTH;

// 三日月のケースの地球の置き方: 描画原点の真下に置き、直下点を北極にする。
const CRESCENT_PLACEMENT: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: 0,
  earthElevationDeg: -90,
  earthAltitudeLog: Math.log10(CRESCENT_ALTITUDE),
  earthLatitudeDeg: 90,
  earthLongitudeDeg: 180,
};

// 地球を自機の真下(−Y)に置いたとき、位相角 120°(地球から見た恒星と自機のなす角)の三日月に
// なる恒星の向き。
const CRESCENT_SUN_DIR = new THREE.Vector3(Math.sin((2 * Math.PI) / 3), Math.cos((2 * Math.PI) / 3), 0);

// 三日月のケースで自機を置く位置(描画座標)。カメラより少し上へ置き、既定の水平な視線で下面を
// 見上げる。地球は画面の外(真下)で、カメラの仰角を上げて見下ろすと見える。
const CRESCENT_SHIP_POSITION = new THREE.Vector3(0, 3, -34);

// 三日月: 実写の地球を真下に置き、自機が三日月の地球から地球照を受ける。恒星は水平から 30° 下に
// あるので、下面のうち直射を受けない側が地球照だけで照らされる。
function crescent(): LabCase {
  return {
    objects: [shipAt(CRESCENT_SHIP_POSITION, SHIP_ROTATION_PORT)],
    camera: labCamera(),
    sunDirection: CRESCENT_SUN_DIR,
    viewTarget: CRESCENT_SHIP_POSITION,
    earth: CRESCENT_PLACEMENT,
  };
}

// 地球のケースで食を起こす球: 地表のどこへ影を落とすか(直下からの中心角 [rad])と、その球の半径・
// 距離。距離に対する半径の比を太陽の視半径(4.65e-3)よりわずかに大きく取ると、本影を半影が
// 縁取る金環直前の配置になる。
const ECLIPSE_GROUND_ANGLE = 0.25;
const ECLIPSE_SHADOW_BODY_RADIUS = 2e5;
const ECLIPSE_SHADOW_BODY_DISTANCE = 3e7;

// 大気の外に置く試験球の位置と半径。カメラと同じ高度帯(403km)に居るので、**カメラとの間に
// 大気が無く、地表と違って霞んではならない。** 地平線を背にした輪郭で読む。
const ABOVE_ATMOSPHERE_CENTER = new THREE.Vector3(0, 0, -5e4);
const ABOVE_ATMOSPHERE_RADIUS = 1e3;

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
// 昼夜境界の撮影の恒星の向き。視線の先の地平線上。
const EARTH_TERMINATOR_SUN = sunAnglesOf(AHEAD.clone().projectOnPlane(EARTH_CENTER.clone().negate().normalize()));
// 日食の撮影の恒星の向き。食を起こす球はこの向きへ置くので、既定の向き(SUN_DIR)の撮影では影の軸が
// 地表点から約 5,000 km(3e7 m × sin 9.5°)外れ、地平線まで(地表距離 約 2,300 km)に斑(半影の
// 半径 約 340 km)は入らない。
const EARTH_ECLIPSE_SUN = {
  ...SUN_DIR_ANGLES,
  sunAzimuthDeg: SUN_DIR_ANGLES.sunAzimuthDeg + 10,
};

// 地球: 低軌道の高度から地平線方向を見て、大気のリムと地表のもや、大気の外に居る物体を見る。日食の
// 撮影の恒星の方向には、食を起こす球を影の源として置く(画面には写らない)。
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
    viewTarget: EARTH_CENTER,
    earth: EARTH_PLACEMENT,
    shadowBodies: [sphereShadowBody(eclipseBodyCenter, ECLIPSE_SHADOW_BODY_RADIUS)],
    shots: {
      'earth': { view: {} },
      // 昼夜境界。**太陽光が最も長く大気を通って届く向き**なので、波長ごとの減衰だけで縁と霞が橙へ
      // 寄っていなければならない。前方散乱が効く向きでもあるので、太陽のまわりのグローもここで読む。
      'earth-terminator': { view: EARTH_TERMINATOR_SUN },
      // 日食。**大気の明暗は入射角だけでなく影の濃さにも比例する**ので、リムともやの両方へ影の落ちた
      // 斑が出る。斑は本影(半径 60km)を半影(340km)が縁取る。
      'earth-eclipse': { view: EARTH_ECLIPSE_SUN },
      // カメラが周回の中心(地球の中心)の反対側へ回り、直下点が元から 40° 離れた位置から地平線を見る。
      // **雲場の cap はカメラの直下点へ追従する**ので、ここでも手前の地表に雲が出なければならない。
      'earth-camera-orbit': { view: { cameraAzimuthDeg: 180 } },
    },
  };
}

// 斜視ケースの、地平線を視線から下げる角 [rad]。負なので地平線は視線の上へ来る — 画面中央の地表を
// 入射角およそ 45° で見下ろす向き。
const EARTH_OBLIQUE_MARGIN = -0.49;
const EARTH_OBLIQUE_PLACEMENT = placementBelowHorizon(LEO_ALTITUDE, EARTH_OBLIQUE_MARGIN);

// 斜視の地球: 低軌道の高度から、視線を地平線より下げて地表を斜めに見下ろす。**積雲の塔を
// 真上からでも真横からでもなく見る向き**なので、雲頂の起伏と塔の側面はここで読む。
function earthOblique(): LabCase {
  return {
    objects: [],
    camera: labCamera(),
    viewTarget: earthCenterOf(EARTH_OBLIQUE_PLACEMENT),
    earth: EARTH_OBLIQUE_PLACEMENT,
  };
}

// 極ケースの地球の視直径が画面の高さに占める割合と、恒星の向き。恒星は極を斜め上から
// 照らす向きへ置き、雲の影が極域いっぱいに伸びるようにする。
const EARTH_POLAR_SCREEN_FRACTION = 0.8;
const EARTH_POLAR_SUN_DIR = new THREE.Vector3(1, 0, 1).normalize();
// 極ケースの地球の視半径 [rad]。
const EARTH_POLAR_APPARENT_RADIUS = THREE.MathUtils.degToRad(FOV_DEG / 2) * EARTH_POLAR_SCREEN_FRACTION;
// 極ケースの地球の置き方: 視線の先(−Z)に置き、北極を描画原点へ向ける。
const EARTH_POLAR_PLACEMENT: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: 180,
  earthElevationDeg: 0,
  earthAltitudeLog: Math.log10(R_EARTH / Math.sin(EARTH_POLAR_APPARENT_RADIUS) - R_EARTH),
  earthLatitudeDeg: 90,
  earthLongitudeDeg: 0,
};

// 北極を真上から見下ろす地球: 自転軸をカメラへ向け、極を中心に見下ろす。**正距円筒の場は極で
// 経度が 1 点へ集まる**ので、場の引き方の破綻はこの構図に出る。
function earthPolar(): LabCase {
  return {
    objects: [],
    camera: labCamera(),
    sunDirection: EARTH_POLAR_SUN_DIR,
    viewTarget: earthCenterOf(EARTH_POLAR_PLACEMENT),
    earth: EARTH_POLAR_PLACEMENT,
    shots: {
      'earth-polar': { view: {} },
      // 極の昼夜境界。恒星を視線と直交させ、昼夜境界を極の上へ通す。**扁平な天体でも影は地平線
      // どおりに落ちる** — 境界は半影ぶんに滑らかで、緯度によらない直線の縁は出ない。天体自身が影を
      // 落とす側に載っていて、地表も雲頂も低い高度の大気も、その内側ではなく表面より外に居ることを
      // ここで読む。
      'earth-polar-terminator': { view: sunAnglesOf(new THREE.Vector3(1, 0, 0)) },
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

// 遠い天体照のケースの地球の方位 [deg] と、月軌道相当の視半径(0.95°)になる中心距離 [m]。
// **カメラの後方左に置く**ので画面には写らない — 板の法線を地球へ向けると板はカメラ側を向くので、
// 両立しない。
const PLANETSHINE_EARTH_AZIMUTH_DEG = anglesFromDirection(new THREE.Vector3(-0.8, 0, 0.6)).azimuthDeg;
const PLANETSHINE_EARTH_DISTANCE = R_EARTH / Math.sin(THREE.MathUtils.degToRad(0.95));
// 遠い天体照のケースの地球の置き方。直下点は、描画原点の向き(地球の向きの反対)にある赤道上の点に
// 取り、天体固定の軸を描画座標の軸へ揃える。
const PLANETSHINE_PLACEMENT: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: PLANETSHINE_EARTH_AZIMUTH_DEG,
  earthElevationDeg: 0,
  earthAltitudeLog: Math.log10(PLANETSHINE_EARTH_DISTANCE - R_EARTH),
  earthLatitudeDeg: 0,
  earthLongitudeDeg: PLANETSHINE_EARTH_AZIMUTH_DEG + 180,
};
const PLANETSHINE_EARTH_CENTER = earthCenterOf(PLANETSHINE_PLACEMENT);
// 恒星は地球のちょうど反対。板の裏から差すので、板に直射は1本も届かない。
const PLANETSHINE_SUN_DIR = PLANETSHINE_EARTH_CENTER.clone().negate().normalize();
// 受け手の板の一辺・横のずれ・奥行き [m]。左を拡散、右を金属にして同じ奥行きへ並べる。
const PLANETSHINE_PLATE_SIZE = 1200;
const PLANETSHINE_PLATE_OFFSET = 800;
const PLANETSHINE_PLATE_DEPTH = 3000;
const PLANETSHINE_DIFFUSE_CENTER = new THREE.Vector3(-PLANETSHINE_PLATE_OFFSET, 0, -PLANETSHINE_PLATE_DEPTH);
const PLANETSHINE_METAL_CENTER = new THREE.Vector3(PLANETSHINE_PLATE_OFFSET, 0, -PLANETSHINE_PLATE_DEPTH);
const PLANETSHINE_VIEW_TARGET = new THREE.Vector3(0, 0, -PLANETSHINE_PLATE_DEPTH);

// 遠い天体照のケースの受け手の板を、center(描画座標)へ置く。
function planetshinePlate(center: THREE.Vector3, roughness: number, metalness: number): THREE.Mesh {
  // **法線は地球への向きとカメラへの向きのちょうど半分**に取る — 鏡面の板が中心で地球を映し、
  // 拡散の板も地球への余弦を残したまま、恒星とは N·L < 0 になる。
  const toEarth = PLANETSHINE_EARTH_CENTER.clone().sub(center).normalize();
  const toCamera = center.clone().negate().normalize();
  return whitePlate(PLANETSHINE_PLATE_SIZE, center, toEarth.add(toCamera).normalize(), roughness, metalness);
}

// 遠い天体照: 月軌道相当の距離に置いた地球だけが照らす板を2枚並べ、**板に出る明るさを天体照だけで
// 決める。** 画素値を厳密に比べるケース。
function planetshineFar(): LabCase {
  return {
    objects: [
      planetshinePlate(PLANETSHINE_DIFFUSE_CENTER, 1, 0),
      planetshinePlate(PLANETSHINE_METAL_CENTER, 0.05, 1),
    ],
    camera: labCamera(),
    sunDirection: PLANETSHINE_SUN_DIR,
    viewTarget: PLANETSHINE_VIEW_TARGET,
    earth: PLANETSHINE_PLACEMENT,
    shots: {
      // 大気と雲は撮り直しのたびに値が揺れる半影の源になるので、描画設定で構図から外す。
      'planetshine-far': {
        view: {},
        graphics: { atmosphere: ATMOSPHERE_QUALITY.off, clouds: false },
      },
    },
  };
}

export const EARTH_CASES = {
  'leo': leo,
  'planetshine-far': planetshineFar,
  'crescent': crescent,
  'earth': earth,
  'earth-oblique': earthOblique,
  'earth-polar': earthPolar,
  'earth-mars': earthMars,
} as const satisfies Record<string, CaseBuilder>;
