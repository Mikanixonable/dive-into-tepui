import type { FloatNode, Vec2Node } from '../tsl-types';

// static prior と現在の dynamic forcing を同じ方向で評価するための environment。最終 coverage や alpha は持たない。
export interface CloudEnvironment {
  readonly latitude: FloatNode;
  readonly temperatureK: FloatNode;
  readonly meanCloudinessPrior: FloatNode;
  readonly landFraction: FloatNode;
  readonly elevationMeters: FloatNode;
  readonly slope: Vec2Node;
  readonly tropopauseMeters: FloatNode;
}
