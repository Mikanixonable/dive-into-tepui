// 座標系パネルの角度コンパス。黄道面・赤道面・月軌道面の3リングを持つ円盤図式と、
// 基準面チップ・真上/真横ボタンをまとめ、1クリックで視点を整列させる。
import type { CameraReferencePlane, CameraReferenceView } from '../../viewer/focus-camera-selection';
import { expandHitTarget } from '../../../hud/widgets/widget-base';
import { referencePlaneLabel } from './frame-labels';
import { angleCompassSvg } from './frame-glyphs';

const REFERENCE_PLANES: readonly CameraReferencePlane[] = ['ecliptic', 'equator', 'moonOrbit'];

function isReferencePlane(value: string): value is CameraReferencePlane {
  return value === 'ecliptic' || value === 'equator' || value === 'moonOrbit';
}

export interface AngleCompassCommands {
  setReferencePlane(plane: CameraReferencePlane): void;
  setReferenceView(view: CameraReferenceView): void;
}

export class AngleCompass {
  public readonly element: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly topBtn: HTMLButtonElement;
  private readonly sideBtn: HTMLButtonElement;
  private readonly planeButtons = new Map<CameraReferencePlane, HTMLButtonElement>();
  private currentPlane: CameraReferencePlane = 'ecliptic';
  private activeView: CameraReferenceView | null = null;
  private lastMarkup = '';

  public constructor(private readonly commands: AngleCompassCommands) {
    this.element = document.createElement('div');
    this.element.className = 'fc-compass-stage';

    const dial = document.createElement('div');
    dial.className = 'fc-compass-dial';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', '0 0 108 92');
    this.svg.setAttribute('class', 'fc-compass-svg');
    this.svg.addEventListener('click', (e) => {
      const target = (e.target as Element | null)?.closest<SVGElement>('[data-compass-plane]');
      const raw = target?.dataset['compassPlane'] ?? null;
      if (raw !== null && isReferencePlane(raw)) this.selectPlane(raw);
    });
    this.topBtn = this.buildSpot('上', '基準面の真上から見る', 'fc-spot-top', 'above');
    this.sideBtn = this.buildSpot('横', '基準面の真横から見る', 'fc-spot-side', 'side');
    dial.append(this.svg, this.topBtn, this.sideBtn);

    const planeCol = document.createElement('div');
    planeCol.className = 'fc-plane-col';
    planeCol.setAttribute('role', 'group');
    planeCol.setAttribute('aria-label', '基準面');
    for (const plane of REFERENCE_PLANES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `fc-plane-chip fc-plane-${plane}`;
      expandHitTarget(btn);
      btn.innerHTML = `<span class="fc-plane-dot" aria-hidden="true"></span><span>${referencePlaneLabel(plane)}</span>`;
      btn.addEventListener('click', (e) => {
        if (e.isTrusted) btn.blur();
        this.selectPlane(plane);
      });
      this.planeButtons.set(plane, btn);
      planeCol.appendChild(btn);
    }
    this.element.append(dial, planeCol);
  }

  public get lastRequestedView(): CameraReferenceView | null {
    return this.activeView;
  }

  private buildSpot(
    text: string, title: string, extraClass: string, view: CameraReferenceView,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `fc-compass-spot ${extraClass}`;
    expandHitTarget(btn);
    btn.textContent = text;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.addEventListener('click', (e) => {
      if (e.isTrusted) btn.blur();
      this.activeView = view;
      this.commands.setReferencePlane(this.currentPlane);
      this.commands.setReferenceView(view);
    });
    return btn;
  }

  private selectPlane(plane: CameraReferencePlane): void {
    this.currentPlane = plane;
    this.commands.setReferencePlane(plane);
    if (this.activeView !== null) this.commands.setReferenceView(this.activeView);
  }

  public sync(plane: CameraReferencePlane): void {
    this.currentPlane = plane;
    const markup = angleCompassSvg(plane, this.activeView);
    if (markup !== this.lastMarkup) {
      this.svg.innerHTML = markup;
      this.lastMarkup = markup;
    }
    this.topBtn.classList.toggle('on', this.activeView === 'above');
    this.sideBtn.classList.toggle('on', this.activeView === 'side');
    for (const [key, btn] of this.planeButtons) {
      const on = key === plane;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }
}
