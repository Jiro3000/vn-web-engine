import type {AsbTag} from '../../formats/artemis/asb.js';

const registrations = [
  'setonautomodein',
  'setonautomodeout',
  'setoncommandskipin',
  'setoncommandskipout',
  'setoncontrolskipin',
  'setoncontrolskipout',
  'setonhidein',
  'setonhideout',
  'setonbacklogin',
  'setonbacklogout',
  'setondirchg',
] as const;
export type ArtemisCommandEvent = (typeof registrations)[number];

/** Native 0x1400df0c0 captures the current file only for label-only registrations. */
export function captureEventCommand(tag: AsbTag, currentFile: () => string): AsbTag {
  const args = new Map(tag.args);
  if (!args.has('file') && args.has('label')) args.set('file', currentFile());
  return {...tag, args};
}

/** Copied native command events. Mode/input owners determine when to dispatch them. */
export class ArtemisEventCommands {
  private readonly commands = new Map<ArtemisCommandEvent, AsbTag>();
  constructor(private readonly currentFile: () => string) {}
  dispatch(tag: AsbTag): boolean {
    if (!(registrations as readonly string[]).includes(tag.name)) return false;
    this.commands.set(tag.name as ArtemisCommandEvent, captureEventCommand(tag, this.currentFile));
    return true;
  }
  command(event: ArtemisCommandEvent): AsbTag | undefined {
    const command = this.commands.get(event);
    return command ? {...command, args: new Map(command.args)} : undefined;
  }
}
