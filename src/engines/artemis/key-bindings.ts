import type {AsbTag} from '../../formats/artemis/asb.js';

function integer(value: string): number {
  const token = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(value);
  const number = token ? Number(token[1]) : 0;
  if (!Number.isInteger(number) || number < -0x80000000 || number > 0x7fffffff)
    throw new Error('Unsupported Artemis key integer');
  return number;
}
export interface ArtemisKeyRole {
  readonly keys: ReadonlySet<number>;
  readonly special136: boolean;
  readonly special137: boolean;
}
interface Role {
  keys: Set<number>;
  special136: boolean;
  special137: boolean;
}

/** Native role configuration and deletion of both push-handler maps.
 * Frame sampling, special-code interpretation and onpush registration are separate input-owner work.
 */
export class ArtemisKeyBindings {
  private readonly roles = new Map<number, Role>();
  private readonly pushHandlers = [new Map<number, AsbTag>(), new Map<number, AsbTag>()] as const;
  role(id: number): ArtemisKeyRole | undefined {
    const role = this.roles.get(id);
    return role ? {...role, keys: new Set([...role.keys].sort((a, b) => a - b))} : undefined;
  }
  /** Owner-side storage of a copied command in native push-map slot 0 or 1. */
  storePushHandler(key: number, slot: 0 | 1, tag: AsbTag): void {
    this.pushHandlers[slot].set(key, {...tag, args: new Map(tag.args)});
  }
  pushHandler(key: number, slot: 0 | 1): AsbTag | undefined {
    const tag = this.pushHandlers[slot].get(key);
    return tag ? {...tag, args: new Map(tag.args)} : undefined;
  }
  dispatch(tag: AsbTag): boolean {
    const p = tag.args;
    if (tag.name === 'delonpush') {
      const key = integer(p.get('key') ?? '');
      this.pushHandlers[0].delete(key);
      this.pushHandlers[1].delete(key);
      return true;
    }
    if (tag.name !== 'keyconfig') return false;
    if (!p.has('role')) throw new Error('Missing Artemis keyconfig role');
    const id = integer(p.get('role')!);
    const role: Role = {keys: new Set(), special136: false, special137: false};
    // Native clears ordinary keys and both special flags even when keys is absent.
    this.roles.set(id, role);
    if (p.has('keys'))
      for (const token of p.get('keys')!.split(',')) {
        const key = integer(token);
        if (key === 136) role.special136 = true;
        else if (key === 137) role.special137 = true;
        else role.keys.add(key);
      }
    return true;
  }
}
