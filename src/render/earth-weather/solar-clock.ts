// 天気のモデルが読む太陽の位置と時刻。太陽直下点の経度と赤緯から、地点の地方太陽時と、地表へ届く
// 日射の強さ(天頂角の余弦)を TSL の式で答える。陸の対流は日射に追随するので、日変化・緯度・季節の
// 依存はここから出る。暦を持つ呼び出し側が直下点を渡さないあいだは、平均太陽日で西へ一周する
// 架空の太陽を使い、赤緯は 0(分点)に置く。
import { cos, float, fract, atan, max, sqrt, uniform } from 'three/tsl';
import type { FloatNode, FloatUniform, Vec3Node } from '../tsl-types';

// 平均太陽日 [s]。発射時刻の地方太陽時は、太陽直下経度がこの周期で西へ一周するとして遡る。
const MEAN_SOLAR_DAY = 86400;

export class SolarClock {
  // 太陽直下経度 [rad]。暦を持つ呼び出し側が setSolarLongitude で上書きしない限り、
  // 平均太陽日の速さで西へ回る架空の太陽を使う。
  private readonly solarLongitude: FloatUniform = uniform(0);
  private solarLongitudeOverride: number | null = null;
  // 現在時刻 [s]。発射時刻の地方太陽時を遡るのに使う。
  private readonly secondsUniform: FloatUniform = uniform(0);
  // 太陽の赤緯の正弦。0 は分点で、直下点が赤道の上にある。
  private readonly sinDeclination: FloatUniform = uniform(0);

  // 時刻 [s] を反映する。
  public syncTime(seconds: number): void {
    this.secondsUniform.value = seconds;
    this.solarLongitude.value =
      this.solarLongitudeOverride ?? (seconds * -2 * Math.PI / MEAN_SOLAR_DAY) % (2 * Math.PI);
  }

  // 天体固定で見た太陽直下点の経度 [rad](経度は正距円筒の u の規約: lon0 が +Z、東が +X)。
  // null を渡すと、平均太陽日で西へ回る架空の太陽へ戻る。
  public setSolarLongitude(rad: number | null): void {
    this.solarLongitudeOverride = rad;
  }

  // 時刻 emissionSeconds [s] における地方太陽時 [時] 0..24(直下点で 12)。太陽直下経度は現在時刻の値から、
  // その時刻まで平均太陽日の速さで遡る — 位相が遡る範囲(移流 1 周期ぶん)なら、実際の太陽も
  // ほぼこの速さで動く。
  public localHourAt(direction: Vec3Node, emissionSeconds: FloatNode): FloatNode {
    const longitude = atan(direction.x, direction.z);
    const emissionSolarLongitude = this.solarLongitude.add(
      this.secondsUniform.sub(emissionSeconds).mul(2 * Math.PI / MEAN_SOLAR_DAY));
    return fract(longitude.sub(emissionSolarLongitude).div(2 * Math.PI).add(0.5)).mul(24);
  }

  // いまの時刻の地方太陽時 [時] 0..24。
  public localHourNowAt(direction: Vec3Node): FloatNode {
    return this.localHourAt(direction, this.secondsUniform);
  }

  // いまの時刻に地表へ届く日射の強さ 0..1(天頂角の余弦。夜は 0)。lagHours [時] は日射のピークからの
  // 遅れで、地面が温まって対流が立つまでの時間を、日射のピークを後ろへずらして表す。
  public daylightAt(direction: Vec3Node, lagHours: FloatNode): FloatNode {
    const hourAngle = this.localHourNowAt(direction).sub(12).sub(lagHours)
      .mul(Math.PI / 12);
    const sinLatitude = direction.y;
    const cosLatitude = sqrt(max(float(1).sub(sinLatitude.mul(sinLatitude)), 0));
    const cosDeclination = sqrt(float(1).sub(this.sinDeclination.mul(this.sinDeclination)));
    return max(
      sinLatitude.mul(this.sinDeclination)
        .add(cosLatitude.mul(cosDeclination).mul(cos(hourAngle))),
      0);
  }
}
