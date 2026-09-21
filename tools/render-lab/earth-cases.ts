// 地球まわりのケース。実写の地球を大気・雲・天体照・影の源として組み、低軌道・三日月・遠い天体照・
// 地平線・斜視・極・火星との構図で置く。地球の組み立てと、直下点を地表の地点へ合わせる自転姿勢も持つ。
import * as THREE from 'three/webgpu';
import { CelestialSurface, type LightSourceMap } from '../../src/render/celestial/celestial-surface';
import { scaledToBondAlbedo, type Albedo } from '../../src/render/celestial-albedo';
import earthSmoothnessUrl from '../../src/assets/earth-smoothness.png';
import { R_EARTH, R_EARTH_EQ } from '../../src/game/celestial/solar-system/earth-system';
import {
  EARTH, EARTH_ATMOSPHERE_OPTICS, EARTH_COASTLINE, earthCloudPresentation,
} from '../../src/game/celestial/solar-system/earth-system';
import { EARTH_TEXTURE } from '../../src/render/earth-surface-defaults';
import { shapeAxes, shapeSpheroidRadii } from '../../src/physics/celestial-body-def';
import { BodyGraticule } from '../../src/render/celestial/body-graticule';
import { LineOverlay } from '../../src/render/celestial/line-overlay';
import { markLitOpaque } from '../../src/render/pipeline/lit-layer';
import { sphereShadowBody } from '../../src/render/pipeline/shadow/body-shadow';
import { MARS, MARS_ATMOSPHERE_OPTICS, MARS_TEXTURE } from '../../src/game/celestial/solar-system/mars-system';
import { LINE_RENDER_ORDER, type LineStyle } from '../../src/render/line-style';
import { directionFromAngles } from './view-angles';
import {
  AHEAD, circle, CLOSE_UP_DIAMETER_PX, FOV_DEG, GREY_SPHERE_ALBEDO, labCamera, MAX_CAMERA_DISTANCE_LOG,
  SHIP_ROTATION_PORT, shipAt, sphere, SUN_DIR_ANGLES, sunAnglesOf, texturedBody,
  type CaseBuilder, type LabCase,
} from './lab-case';
import type { AtmosphereBody, AtmosphereClouds } from '../../src/render/atmosphere';
import type { RenderStyle } from '../../src/render/render-style';

// 地球を光源として扱うときの色つきアルベド(ゲーム本体の Earth と同じ測光)。
const EARTH_LIGHT_ALBEDO: Albedo = scaledToBondAlbedo(EARTH_TEXTURE.averageHue, EARTH_TEXTURE.bondAlbedo);

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

// 低軌道のケースで自機と拡散板を置く位置(描画座標)。自機はカメラより少し上へ置いて下面が見える
// ようにし、板は恒星が真上でも自機の影に入らないよう、自機の右へ離す。
const LEO_SHIP_POSITION = new THREE.Vector3(-5, 3, -30);
const LEO_PLATE_CENTER = new THREE.Vector3(9, 0, -26);
// 拡散板の法線と一辺 [m]。法線は真下の地球を向きつつ、面がカメラからも見える向きへ傾けてある。
const LEO_PLATE_NORMAL = new THREE.Vector3(0, -0.7, 0.7).normalize();
const LEO_PLATE_SIZE = 8;

// 地球低軌道: 直下がサハラの実写の地球の上に、自機・白い拡散板・自機の円軌道を置く。視線は軌道の
// 接線方向なので、地平線と、そこへ伸びていく自分の軌道が入る。
function leo(style: RenderStyle): LabCase {
  const camera = labCamera(6e7);
  const center = new THREE.Vector3(0, -LEO_CENTER_DISTANCE, 0);
  const earthSphere = earthAt(center, style, camera, spinForSubCameraPoint(center, SAHARA_DIRECTION));
  // 自機の軌道は、地球の中心と自機を通り、視線の先(−Z)へ伸びる円。
  const toShip = new THREE.Vector3().subVectors(LEO_SHIP_POSITION, center);
  const u = toShip.clone().normalize();
  const v = AHEAD.clone().projectOnPlane(u).normalize();
  const orbitStyle: LineStyle = { color: 0x6fd3ff, opacity: 0.9, renderOrder: LINE_RENDER_ORDER.shipOrbit };
  return {
    objects: [
      earthSphere.object,
      shipAt(LEO_SHIP_POSITION, SHIP_ROTATION_PORT),
      whitePlate(LEO_PLATE_SIZE, LEO_PLATE_CENTER, LEO_PLATE_NORMAL, 1, 0),
      circle(center, toShip.length(), u, v, orbitStyle, camera),
    ],
    camera,
    viewTarget: LEO_SHIP_POSITION,
    ...earthSphere.lightingAndClouds,
    shots: {
      // 軌道の線が自機と地球(地平線)に正しく隠れるかと、自機の陰影を見る。
      'leo': {},
      // 地球照。恒星は真上から差すので、自機の上面だけが直射を受け、下面と板は地球照だけで照らされる。
      // **板の色は直下のサハラの地表の色で決まる。** 横を向いた面はどちらの光も受けず桁で暗い。
      'earthshine': { sunElevationDeg: 90 },
    },
  };
}

// 三日月のケースで地球の中心を置く距離 [m]。天体照は受け手から見えている地表の日照で決まるので、
// 位相角 φ の三日月から光が届くには、可視キャップの半角 acos(R/d) が φ − 90° を超える必要がある。
// 1.5 地球半径では 48.2° あり、位相角 120° が要求する 30° を超える。
const CRESCENT_CENTER_DISTANCE = 1.5 * R_EARTH;

// 地球を自機の真下(−Y)に置いたとき、位相角 120°(地球から見た恒星と自機のなす角)の三日月に
// なる恒星の向き。
const CRESCENT_SUN_DIR = new THREE.Vector3(Math.sin((2 * Math.PI) / 3), Math.cos((2 * Math.PI) / 3), 0);

// 三日月のケースで自機を置く位置(描画座標)。カメラより少し上へ置き、既定の水平な視線で下面を
// 見上げる。地球は画面の外(真下)で、カメラの仰角を上げて見下ろすと見える。
const CRESCENT_SHIP_POSITION = new THREE.Vector3(0, 3, -34);

// 三日月: 実写の地球を真下に置き、自機が三日月の地球から地球照を受ける。恒星は水平から 30° 下に
// あるので、下面のうち直射を受けない側が地球照だけで照らされる。
function crescent(style: RenderStyle): LabCase {
  const center = new THREE.Vector3(0, -CRESCENT_CENTER_DISTANCE, 0);
  const camera = labCamera(6e7);
  const earthSphere = earthAt(center, style, camera);
  return {
    objects: [earthSphere.object, shipAt(CRESCENT_SHIP_POSITION, SHIP_ROTATION_PORT)],
    camera,
    sunDirection: CRESCENT_SUN_DIR,
    viewTarget: CRESCENT_SHIP_POSITION,
    ...earthSphere.lightingAndClouds,
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

// 地球を、中心 center(描画座標)・天体固定の姿勢 spin で、寄り切った分割段で組む。地表・積雲の殻・
// 模式図でだけ出る経緯度グリッドと海岸線は、ゲーム本体と同じ部品から組む。lightingAndClouds は、この
// 地球を大気・天体照・影・積雲の影の源とし、雲場と画像の揃いを扱うケースの欄で、そのまま広げられる。
// camera はケースのカメラで、雲場の cap はその直下点へ追従する。
export function earthAt(
  center: THREE.Vector3, style: RenderStyle, camera: THREE.Camera, spin = new THREE.Quaternion(),
): {
  readonly object: THREE.Object3D;
  readonly atmosphere: AtmosphereBody;
  readonly lightSourceMap: () => LightSourceMap | null;
  readonly bodyFromWorld: THREE.Matrix4;
  readonly lightingAndClouds: Required<Pick<
    LabCase,
    'atmospheres' | 'planetLights' | 'shadowBodies' | 'cumulus'
    | 'ready' | 'applyGraphics' | 'bakeClouds' | 'disposeClouds'
  >>;
} {
  const group = new THREE.Group();
  group.position.copy(center);
  group.quaternion.copy(spin);
  const axes = shapeAxes(R_EARTH_EQ, EARTH.shape);
  const radii = shapeSpheroidRadii(R_EARTH_EQ, EARTH.shape);
  group.scale.set(axes.x, axes.y, axes.z);
  const cumulus = earthCloudPresentation();
  const shellAxes = new THREE.Vector3(axes.x, axes.y, axes.z);
  const surface = CelestialSurface.textured(EARTH_TEXTURE, earthSmoothnessUrl);
  surface.addTo(group);
  surface.syncLod(CLOSE_UP_DIAMETER_PX);
  cumulus.addTo(group);
  const bodyFromWorld = new THREE.Matrix4().makeRotationFromQuaternion(spin.clone().invert());
  // **組は毎フレーム取り直す** — 雲の分布を切り替えると写しが別のテクスチャになる。
  const clouds: AtmosphereClouds = { get cloud() { return cumulus.renderInput; }, bodyFromWorld };
  const graticule = new BodyGraticule();
  graticule.addTo(group);
  graticule.setVisible(style === 'schematic');
  const coastline = LineOverlay.of({ kind: 'latLonPolylines', polylines: EARTH_COASTLINE });
  coastline.addTo(group);
  coastline.setVisible(style === 'schematic');
  // 大気の地表は地表メッシュと同じ楕円体に採る。**真球で渡すと**、極で地表と空のあいだに
  // 隙間が開く。
  const atmosphere: AtmosphereBody = {
    center,
    surfaceRadius: radii.equatorRadius,
    polarAxis: new THREE.Vector3(0, 1, 0).applyQuaternion(spin),
    polarRatio: radii.polarRadius / radii.equatorRadius,
    optics: EARTH_ATMOSPHERE_OPTICS,
    // 雲を描かない間は雲を持たない(ゲーム本体の大気の候補と同じ規則)。
    get clouds() { return cumulus.cloudsVisible ? clouds : null; },
  };
  // 光源として焼く地表のテクスチャ。ベース色の画像が GPU へ届くまでは null。
  const lightSourceMap = (): LightSourceMap | null => surface.lightSourceMap;
  return {
    object: group,
    atmosphere,
    lightSourceMap,
    bodyFromWorld,
    lightingAndClouds: {
      atmospheres: [atmosphere],
      planetLights: [{
        center, radius: R_EARTH, albedo: EARTH_LIGHT_ALBEDO, lightSourceMap, bodyFromWorld, atmosphere,
      }],
      // 天体自身が落とす影。地表・雲頂・低い高度の大気が直射を失う境界はこれが決める。
      shadowBodies: [{ center, axes: shellAxes.clone(), bodyFromWorld }],
      cumulus: {
        center,
        surfaceRadius: R_EARTH_EQ,
        axes: shellAxes,
        bodyFromWorld,
        get cloud() { return cumulus.renderInput; },
      },
      // 地表が読む画像(ベース色と滑らかさ)がすべて GPU へ届いたか。
      ready: () => surface.imagesReady,
      // 殻の分割段は寄り切った 1 段に固定(ケースのカメラ距離は観察のつまみで動くが、
      // 絵の比較は最も細かい段で行う)。雲場の cap は、雲を描くフレームでこのフレームのカメラの
      // 直下点へ置き直す — ゲーム本体と同じ規則。
      applyGraphics: (graphics) => {
        cumulus.syncGraphics(graphics, CLOSE_UP_DIAMETER_PX);
        if (graphics.clouds) cumulus.aimFrom(camera.position, center, spin, shellAxes);
      },
      bakeClouds: (renderer, displayTime, gpu) => cumulus.bake(renderer, displayTime, gpu),
      disposeClouds: () => cumulus.dispose(),
    },
  };
}

// 低軌道の高度 [m] と、その高度から見た地球の中心距離 [m]。視半径が 69.7° あるので、地球を真正面へ
// 置くと画面を埋める。
const LEO_ALTITUDE = 420e3;
export const LEO_CENTER_DISTANCE = R_EARTH + LEO_ALTITUDE;

// 斜視ケースの、地平線を視線から下げる角 [rad]。負なので地平線は視線の上へ来る — 画面中央の地表を
// 入射角およそ 45° で見下ろす向き。
const EARTH_OBLIQUE_MARGIN = -0.49;

// 高度 altitude [m] のカメラ(原点)から見て、地球の地平線が視線から margin [rad] だけ下へ来る
// 向きの地球中心。
function earthCenterBelowHorizon(altitude: number, margin: number): THREE.Vector3 {
  const dist = R_EARTH + altitude;
  const tilt = Math.asin(R_EARTH / dist) + margin;
  return new THREE.Vector3(0, -Math.sin(tilt), -Math.cos(tilt)).multiplyScalar(dist);
}

// 地球のケースの地球の中心(描画座標)。
const EARTH_CENTER = earthCenterBelowHorizon(LEO_ALTITUDE, 0);
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
function earth(style: RenderStyle): LabCase {
  const center = EARTH_CENTER.clone();
  const camera = labCamera(6e7);
  const earthSphere = earthAt(center, style, camera);
  // 食を起こす球が影を落とす地表点。カメラ直下と地平線(地表距離 2,255km)の中間へ来るよう、
  // 直下の向きを視線側へ回す。
  const groundDir = center.clone().negate().normalize()
    .applyAxisAngle(new THREE.Vector3(1, 0, 0), -ECLIPSE_GROUND_ANGLE);
  const ground = center.clone().addScaledVector(groundDir, R_EARTH);
  const eclipseSunDirection = directionFromAngles(
    EARTH_ECLIPSE_SUN.sunAzimuthDeg, EARTH_ECLIPSE_SUN.sunElevationDeg, new THREE.Vector3(),
  );
  const eclipseBodyCenter = ground.clone().addScaledVector(eclipseSunDirection, ECLIPSE_SHADOW_BODY_DISTANCE);
  return {
    objects: [
      earthSphere.object,
      sphere(GREY_SPHERE_ALBEDO, ABOVE_ATMOSPHERE_RADIUS, ABOVE_ATMOSPHERE_CENTER),
    ],
    camera,
    ...earthSphere.lightingAndClouds,
    shadowBodies: [
      sphereShadowBody(eclipseBodyCenter, ECLIPSE_SHADOW_BODY_RADIUS),
      ...earthSphere.lightingAndClouds.shadowBodies,
    ],
    shots: {
      'earth': {},
      // 昼夜境界。**太陽光が最も長く大気を通って届く向き**なので、波長ごとの減衰だけで縁と霞が橙へ
      // 寄っていなければならない。前方散乱が効く向きでもあるので、太陽のまわりのグローもここで読む。
      'earth-terminator': EARTH_TERMINATOR_SUN,
      // 日食。**大気の明暗は入射角だけでなく影の濃さにも比例する**ので、リムともやの両方へ影の落ちた
      // 斑が出る。斑は本影(半径 60km)を半影(340km)が縁取る。
      'earth-eclipse': EARTH_ECLIPSE_SUN,
      // カメラが周回の中心の反対側へ回り、直下点が元から 40° 離れた位置から地平線を見る。**雲場の cap は
      // カメラの直下点へ追従する**ので、ここでも手前の地表に雲が出なければならない。
      'earth-camera-orbit': { cameraAzimuthDeg: 180 },
    },
  };
}

// 斜視の地球: 低軌道の高度から、視線を地平線より下げて地表を斜めに見下ろす。**積雲の塔を
// 真上からでも真横からでもなく見る向き**なので、雲頂の起伏と塔の側面はここで読む。
function earthOblique(style: RenderStyle): LabCase {
  const center = earthCenterBelowHorizon(LEO_ALTITUDE, EARTH_OBLIQUE_MARGIN);
  const camera = labCamera(6e7);
  const earthSphere = earthAt(center, style, camera);
  return {
    objects: [earthSphere.object],
    camera,
    ...earthSphere.lightingAndClouds,
  };
}

// 極ケースの地球の視直径が画面の高さに占める割合と、恒星の向き。恒星は極を斜め上から
// 照らす向きへ置き、雲の影が極域いっぱいに伸びるようにする。
const EARTH_POLAR_SCREEN_FRACTION = 0.8;
const EARTH_POLAR_SUN_DIR = new THREE.Vector3(1, 0, 1).normalize();

// 北極を真上から見下ろす地球: 自転軸をカメラへ向け、極を中心に見下ろす。**正距円筒の場は極で
// 経度が 1 点へ集まる**ので、場の引き方の破綻はこの構図に出る。
function earthPolar(style: RenderStyle): LabCase {
  // 地球の視半径 [rad]。
  const apparentRadius = THREE.MathUtils.degToRad(FOV_DEG / 2) * EARTH_POLAR_SCREEN_FRACTION;
  const center = new THREE.Vector3(0, 0, -R_EARTH / Math.sin(apparentRadius));
  // 天体固定の +Y(北極)を、カメラの居る +Z へ倒す。
  const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const camera = labCamera(6e7);
  const earthSphere = earthAt(center, style, camera, spin);
  return {
    objects: [earthSphere.object],
    camera,
    sunDirection: EARTH_POLAR_SUN_DIR,
    ...earthSphere.lightingAndClouds,
    shots: {
      'earth-polar': {},
      // 極の昼夜境界。恒星を視線と直交させ、昼夜境界を極の上へ通す。**扁平な天体でも影は地平線
      // どおりに落ちる** — 境界は半影ぶんに滑らかで、緯度によらない直線の縁は出ない。天体自身が影を
      // 落とす側に載っていて、地表も雲頂も低い高度の大気も、その内側ではなく表面より外に居ることを
      // ここで読む。
      'earth-polar-terminator': sunAnglesOf(new THREE.Vector3(1, 0, 0)),
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

// 地球と火星: 大気を持つ天体が2体ある構図。カメラは地球の大気の中から、地平線のすぐ上へ出た
// 火星を見る。**火星の円盤は下縁ほど厚い地球の大気越しに見える**ので、主天体の大気の下で遠くの
// 大気天体がどう保たれるかが1枚の中の階調として出る。距離のつまみを縮めていくと、途中で主天体が
// 入れ替わる。
function earthMars(style: RenderStyle): LabCase {
  const camera = labCamera(1e13);
  const marsCenter = new THREE.Vector3(0, 0, -EARTH_MARS_DISTANCE);
  const margin = EARTH_MARS_HORIZON_CLEARANCE * Math.asin(MARS_RADIUS / EARTH_MARS_DISTANCE);
  const earthCenter = earthCenterBelowHorizon(EARTH_MARS_CAMERA_ALTITUDE, margin);
  const earthSphere = earthAt(earthCenter, style, camera);
  const mars = texturedBody(MARS_TEXTURE, MARS, marsCenter, CLOSE_UP_DIAMETER_PX);
  const marsRadii = shapeSpheroidRadii(MARS.radius, MARS.shape);
  return {
    objects: [earthSphere.object, mars.object],
    camera,
    viewTarget: marsCenter,
    atmospheres: [
      earthSphere.atmosphere,
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
    ready: () => earthSphere.lightingAndClouds.ready() && mars.ready(),
    applyGraphics: earthSphere.lightingAndClouds.applyGraphics,
    bakeClouds: earthSphere.lightingAndClouds.bakeClouds,
    disposeClouds: earthSphere.lightingAndClouds.disposeClouds,
  };
}

// 緯度・経度 [deg] から天体固定の向きへ。正距円筒テクスチャの取り決め(経度 0 が +Z、東が +X、
// 北極が +Y)と同じ。
function bodyDirection(latitudeDeg: number, longitudeDeg: number): THREE.Vector3 {
  const latitude = THREE.MathUtils.degToRad(latitudeDeg);
  const longitude = THREE.MathUtils.degToRad(longitudeDeg);
  return new THREE.Vector3(
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
    Math.cos(latitude) * Math.cos(longitude),
  );
}

// サハラの地点(天体固定の向き)。
export const SAHARA_DIRECTION = bodyDirection(23, 13);

// カメラ(原点)の直下点が、天体固定の subCameraPoint になる自転姿勢。center は天体の中心(描画座標)。
export function spinForSubCameraPoint(center: THREE.Vector3, subCameraPoint: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(subCameraPoint, center.clone().negate().normalize());
}

// 遠い天体照のケースの地球: 月軌道相当の視半径になる中心(描画座標)。**カメラの後方左に置く**
// ので画面には写らない — 板の法線を地球へ向けると板はカメラ側を向くので、両立しない。
const PLANETSHINE_EARTH_CENTER = new THREE.Vector3(-0.8, 0, 0.6).normalize()
  .multiplyScalar(R_EARTH / Math.sin(THREE.MathUtils.degToRad(0.95)));
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
function planetshineFar(style: RenderStyle): LabCase {
  const camera = labCamera(1e13);
  const earthSphere = earthAt(PLANETSHINE_EARTH_CENTER, style, camera);
  return {
    objects: [
      earthSphere.object,
      planetshinePlate(PLANETSHINE_DIFFUSE_CENTER, 1, 0),
      planetshinePlate(PLANETSHINE_METAL_CENTER, 0.05, 1),
    ],
    camera,
    sunDirection: PLANETSHINE_SUN_DIR,
    viewTarget: PLANETSHINE_VIEW_TARGET,
    // 大気・積雲・天体の影は構図から外す — どれも撮り直しのたびに値が揺れる半影の源になる。
    planetLights: [{
      center: PLANETSHINE_EARTH_CENTER,
      radius: R_EARTH,
      albedo: EARTH_LIGHT_ALBEDO,
      lightSourceMap: earthSphere.lightSourceMap,
      bodyFromWorld: earthSphere.bodyFromWorld,
    }],
    ready: earthSphere.lightingAndClouds.ready,
    disposeClouds: earthSphere.lightingAndClouds.disposeClouds,
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
