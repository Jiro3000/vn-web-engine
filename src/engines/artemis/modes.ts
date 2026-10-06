import type {AsbTag} from '../../formats/artemis/asb.js';

export interface ArtemisModeEffects {
  writeStatus(name: string, value: string): void;
  commandSkipChanged(active: boolean): void;
  controlSkipChanged(active: boolean): void;
  /** Host handles auto indicator, pending wait cancellation and registered events. */
  automodeChanged(active: boolean): void;
  releaseScheduler(): void;
}

/** Rev.3179 mode command state. Rendering/input effects remain supplied platform services. */
export class ArtemisModes {
  /** Undefined until configured; full history collection/serialization is a separate owner. */
  alreadyReadEnabled: boolean | undefined;
  writeBacklog: boolean | undefined;
  rightClickAllowed: boolean | undefined;
  rightClickScript: string | undefined;
  skipAllowed = true;
  skipUnread = false;
  commandSkip = false;
  controlSkip = false;
  automodeAllowed = true;
  automode = false;
  automodeLayer: string | null = null;
  stopAutoByClick = false;
  stopAutoByStop = false;
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
      case 'automode':
        this.automodeLayer = p.has('layer') ? p.get('layer')! : null;
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
