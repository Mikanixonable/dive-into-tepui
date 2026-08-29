// 天気が凝結する雲を焼いた写し。r が不透明雲、g が薄い雲の光学的厚みで、この並びが雲を読む側との
// 契約になる。
import * as THREE from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { BakedField } from './baked-field';
import { condense } from './condensation';
import type { WeatherModel } from './weather-model';

// model がいま指している時刻の雲を焼く写し。読む前に render() を呼ぶ。
export function createCloudField(model: WeatherModel): BakedField {
  return new BakedField('cloud', THREE.RGFormat, (direction) => {
    const cloud = condense(model.weatherAt(direction));
    return vec4(cloud.opaque, cloud.translucent, 0, 1);
  });
}
