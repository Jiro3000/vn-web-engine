import type {AsbTag} from '../../formats/artemis/asb.js';

export interface ArtemisModeEffects {
  writeStatus(name: string, value: string): void;
  commandSkipChanged(active: boolean): void;
  controlSkipChanged(active: boolean): void;
  /** Host handles auto indicator, pending wait cancellation and registered events. */
  automodeChanged(active: boolean): void;
  releaseScheduler(): void;
  /** Script +0x35e0: the current message layer name. */
  currentMessageLayer(): string;
}

/** CIconInfo: `present` is byte +8, `layer` the string +0x10 (kept when `present` clears). */
export interface ArtemisAutomodeLayer {
  present: boolean;
  layer: string;
}

/** Rev.3179 mode command state. Rendering/input effects remain supplied platform services. */
export class ArtemisModes {
  /** Constructor bytes b60/37f0 enable these flags; history collection has a separate owner. */
  alreadyReadEnabled = true;
  writeBacklog = true;
  /** Constructor/bf210: request dword cc8 = 0 (allow byte ccb), cd0 = "rclick.iet". */
  rightClickAllowed = false;
  rightClickScript = 'rclick.iet';
  skipAllowed = true;
  skipUnread = false;
  commandSkip = false;
  controlSkip = false;
  /** Constructor dword +0x30 = 0 leaves automode disallowed (byte +0x32) until [automode]. */
  automodeAllowed = false;
  automode = false;
  /** +0x38: automode indicator layer per message layer (find-or-create in `automode`). */
  readonly automodeLayers = new Map<string, ArtemisAutomodeLayer>();
  /** Constructor/bf210 word 3594 = 0x101. */
  stopAutoByClick = true;
  stopAutoByStop = true;
  syncSe: string[] = [];
  autosave: 0 | 1 | 2 = 0;
  constructor(private readonly effects: ArtemisModeEffects) {}

  setCommandSkip(active: boolean, force = false): void {
    if ((active && !force && !this.skipAllowed) || active === this.commandSkip) return;
    this.commandSkip = active;
    this.effects.writeStatus('s.status.commandskip', active ? '1' : '0');
    this.effects.commandSkipChanged(active);
  }
  setControlSkip(active: boolean): void {
    if ((active && !this.skipAllowed) || active === this.controlSkip) return;
    this.controlSkip = active;
    this.effects.writeStatus('s.status.controlskip', active ? '1' : '0');
    this.effects.controlSkipChanged(active);
  }
  setAutomode(active: boolean, force = false): void {
    if ((active && !force && !this.automodeAllowed) || active === this.automode) return;
    this.automode = active;
    this.effects.writeStatus('s.status.automode', active ? '1' : '0');
    this.effects.automodeChanged(active);
  }
  /** bf210 mode fields after automode off and scheduler release (owned by the reset caller).
   * skipUnread (35b0) and the command/control skip states are not reset. */
  reset(): void {
    this.automodeAllowed = false;
    this.skipAllowed = true;
    this.automodeLayers.clear();
    this.alreadyReadEnabled = true;
    this.rightClickAllowed = false;
    this.rightClickScript = 'rclick.iet';
    this.autosave = 0;
    this.stopAutoByClick = this.stopAutoByStop = true;
    this.syncSe = [];
    this.writeBacklog = true;
  }
  /** Returns false for commands outside this mode service. */
  dispatch(tag: AsbTag): boolean {
    const p = tag.args;
    switch (tag.name) {
      case 'alreadyread':
        this.alreadyReadEnabled = p.get('mode') !== '0';
        return true;
      case 'writebacklog':
        this.writeBacklog = p.has('mode') && p.get('mode') !== '0';
        return true;
      case 'rclick':
        this.rightClickAllowed = p.get('allow') !== '0';
        if (p.has('file')) this.rightClickScript = p.get('file')!;
        return true;
      case 'skip':
        if (p.get('allow') === '0') {
          this.setCommandSkip(false);
          this.setControlSkip(false);
          this.skipAllowed = false;
        } else this.skipAllowed = true;
        if (p.has('unread')) this.skipUnread = p.get('unread') !== '0';
        return true;
      case 'automode': {
        const owner = this.effects.currentMessageLayer();
        let entry = this.automodeLayers.get(owner);
        if (!entry) this.automodeLayers.set(owner, (entry = {present: false, layer: ''}));
        entry.present = p.has('layer');
        if (entry.present) entry.layer = p.get('layer')!;
        if (p.has('stopbyclick')) this.stopAutoByClick = p.get('stopbyclick') !== '0';
        if (p.has('stopbystop')) this.stopAutoByStop = p.get('stopbystop') !== '0';
        if (p.has('syncse')) {
          if (p.get('syncse'))
            throw new Error('Nonempty automode syncse list parsing is not implemented');
          this.syncSe = [];
        }
        if (p.get('allow') === '0') {
          this.setAutomode(false);
          this.effects.releaseScheduler();
          this.automodeAllowed = false;
        } else this.automodeAllowed = true;
        return true;
      }
      case 'autosave': {
        const allow = p.get('allow');
        if (allow === '0' || allow === '1' || allow === '2')
          this.autosave = Number(allow) as 0 | 1 | 2;
        return true;
      }
      default:
        return false;
    }
  }
}
