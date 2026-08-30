// 天気が凝結する雲を焼いた写し。r が不透明な雲の被覆率、g が雲頂高度 [m]、b が薄い雲の
// 光学的厚みで、この並びが雲を読む側との契約になる。
import * as THREE from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { BakedField } from './baked-field';
import { condense } from './condensation';
import type { FieldProjection } from './field-projection';
import type { WeatherModel } from './weather-model';

// model がいま指している時刻の雲を、projection の持ち方で焼く写し。読む前に render() を呼ぶ。
export function createCloudField(model: WeatherModel, projection: FieldProjection): BakedField {
  return new BakedField('cloud', THREE.RGBAFormat, projection, 1, (direction) => {
    const cloud = condense(model.weatherAt(direction));
    return vec4(cloud.coverage, cloud.cloudTop, cloud.translucent, 1);
  });
}
