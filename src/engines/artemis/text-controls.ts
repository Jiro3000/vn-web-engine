import type {AsbTag} from '../../formats/artemis/asb.js';

export interface ArtemisTextControlHost {
  currentMessageLayer(): string;
  messageLayerExists(id: string): boolean;
  /** 0x14014f490 mode=0 creates/selects the native message layer; owner supplies its graphics/text effects. */
  selectMessageLayer(id: string): void;
  /** Clear all native backlog collections, not only displayed text. */
  clearBacklog(): void;
}
export interface ArtemisBacklogLayer {
  readonly useOverride: boolean;
  readonly layer: string;
}

/** UTF-8 text configuration from 0x1400d4cb0 / 0x1400d4a10.
 * This configuration does not render backlog or implement message-hide input actions.
 */
export class ArtemisTextControls {
  backlogAllowed = false;
  backlogIncludeFont = true;
  backlogMessageLayer = 'backlog';
  hideAllowed = false;
  private hideWindows = new Set<string>();
  private backlogHiddenLayers = new Set<string>();
  private readonly backlogLayers = new Map<string, ArtemisBacklogLayer>();
  constructor(private readonly host: ArtemisTextControlHost) {}
  get hiddenWindows(): ReadonlySet<string> {
    return new Set(this.hideWindows);
  }
  get hiddenBacklogLayers(): ReadonlySet<string> {
    return new Set(this.backlogHiddenLayers);
  }
  backlogLayer(messageLayer: string): ArtemisBacklogLayer | undefined {
    return this.backlogLayers.get(messageLayer);
  }
  /** bf210 restores the constructor configuration (37b8..3808). */
  reset(): void {
    this.backlogAllowed = false;
    this.backlogIncludeFont = true;
    this.backlogMessageLayer = 'backlog';
    this.hideAllowed = false;
    this.hideWindows = new Set();
    this.backlogHiddenLayers = new Set();
    this.backlogLayers.clear();
  }
  dispatch(tag: AsbTag): boolean {
    const p = tag.args;
    if (tag.name === 'hide') {
      this.hideAllowed = p.get('allow') !== '0';
      if (p.has('window')) this.hideWindows = new Set(p.get('window')!.split(','));
      return true;
    }
    if (tag.name !== 'backlog') return false;
    const current = this.host.currentMessageLayer();
    this.backlogAllowed = p.get('allow') !== '0';
    if (p.has('includefont')) this.backlogIncludeFont = p.get('includefont') !== '0';
    if (p.has('messagelayer')) {
      this.backlogMessageLayer = p.get('messagelayer')!;
      if (!this.host.messageLayerExists(this.backlogMessageLayer)) {
        this.host.selectMessageLayer(this.backlogMessageLayer);
        this.host.selectMessageLayer(current);
      }
    }
    const previous = this.backlogLayers.get(current);
    this.backlogLayers.set(
      current,
      Object.freeze({
        useOverride: p.has('layer'),
        // Native omitting layer resets its use flag but retains its prior string.
        layer: p.get('layer') ?? previous?.layer ?? '',
      }),
    );
    // Native delimiter splitting preserves empty elements and literal whitespace.
    if (p.has('hide')) this.backlogHiddenLayers = new Set(p.get('hide')!.split(','));
    if (p.has('clear') && p.get('clear') !== '0') this.host.clearBacklog();
    return true;
  }
}
