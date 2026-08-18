// 姿勢制御アクチュエータが要求する資源。磁気トルカとフライホイールで要る資源が違い、
// どちらを先に作れるようになるかが進行の形を決める。
import { ResourceId } from './resource';

export interface ActuatorMaterialRequirement {
  readonly actuatorId: string;
  readonly name: string;
  // 必ず要る資源。
  readonly requiredResources: readonly ResourceId[];
  // それぞれの組から1つずつ選べばよい資源。
  readonly alternativeResources: readonly (readonly ResourceId[])[];
}

export const ACTUATOR_MATERIALS = {
  magnetorquer: {
    actuatorId: 'magnetorquer',
    name: '磁気トルカ',
    // 鉄芯と導線のコイルであり、永久磁石を使わない。
    requiredResources: ['iron'],
    alternativeResources: [['aluminium', 'copper']],
  },
  flywheel: {
    actuatorId: 'flywheel',
    name: 'フライホイール',
    // 駆動モーターの永久磁石に希土類が要る。
    requiredResources: ['rare-earth', 'iron'],
    alternativeResources: [],
  },
} satisfies Record<string, ActuatorMaterialRequirement>;

export type ActuatorId = keyof typeof ACTUATOR_MATERIALS;
