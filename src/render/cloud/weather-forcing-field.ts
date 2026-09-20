// 雲の生成へ渡す低次元の論理 forcing。各 producer は最終 alpha や雲種を直接作らず、
// この4 driverへ寄与する。GPU textureを所有しない純粋な契約で、必要な場合だけ既存の
// field node を組み合わせて評価する。

import { clamp, mix } from 'three/tsl';
import type { FloatNode, Vec2Node } from '../tsl-types';

export interface WeatherForcingField {
  readonly moisture: FloatNode;
  readonly lift: FloatNode;
  readonly organization: FloatNode;
  readonly windPerturbation: Vec2Node;
}

export function weatherForcingField(
  moisture: FloatNode, lift: FloatNode, organization: FloatNode, windPerturbation: Vec2Node,
): WeatherForcingField {
  return {
    moisture: clamp(moisture, 0, 1),
    lift,
    organization: clamp(organization, 0, 1),
    windPerturbation,
  };
}

// dynamic anomalyをenvironmentのpriorへ連続的に混ぜる。front / cyclone / ITCZを排他的な
// 雲種切替にせず、同じ凝結・profile経路へ通すための合成関数。
export function blendWeatherForcing(
  environment: WeatherForcingField, anomaly: WeatherForcingField, weight: FloatNode,
): WeatherForcingField {
  return weatherForcingField(
    mix(environment.moisture, anomaly.moisture, weight),
    mix(environment.lift, anomaly.lift, weight),
    mix(environment.organization, anomaly.organization, weight),
    mix(environment.windPerturbation, anomaly.windPerturbation, weight),
  );
}
