import * as assert from 'node:assert/strict';
import { ModularShip } from '../../src/game/ship/modular-ship';
import { Stage } from '../../src/game/stages/stage';
import type { SimSpeedManager } from '../../src/game/dynamic/sim-speed-manager';
import type { EntityRegistry } from '../../src/game/dynamic/entity-registry';
import { test } from '../harness';

class StageProbe extends Stage {
  protected briefingHtml(): string {
    return '';
  }

  public update(_dt: number, _simTime: number, _simSpeed: SimSpeedManager): void {}

  public selectedShip(): ModularShip | null {
    return this.controlledShip;
  }

  public scriptedShip(): ModularShip | null {
    return this.ship;
  }
}

export function register(): void {
  test('stage controlled ship: 艦以外を選択中のユーザー操作に艦のフォールバックを使わない', () => {
    const aliveShip = Object.create(ModularShip.prototype) as ModularShip;
    Object.defineProperty(aliveShip, 'motion', { value: { alive: true } });
    const stage = Object.create(StageProbe.prototype) as StageProbe;
    Object.assign(stage, {
      _controlSelection: { current: {} },
      _dynamicSystem: { all: () => [aliveShip] } as unknown as EntityRegistry,
    });

    assert.equal(stage.selectedShip(), null);
    assert.equal(stage.scriptedShip(), aliveShip);
  });
}
