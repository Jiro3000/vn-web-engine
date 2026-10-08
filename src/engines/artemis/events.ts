export const ARTEMIS_EVENTS = [
  'onEnterFrame',
  'onClickWaitIn',
  'onClickWaitOut',
  'onSave',
  'onLoad',
  'onInputEvent',
  'onDebugSkipOut',
] as const;
export type ArtemisEvent = (typeof ARTEMIS_EVENTS)[number];

/** Native 0x140133730 copies recognized callback names; registrations are patches. */
export class ArtemisEvents {
  private readonly handlers = new Map<ArtemisEvent, string>();
  constructor(private readonly invoke: (name: string, args: ReadonlyMap<string, string>) => void) {}
  register(entries: Iterable<readonly [string, string]>): void {
    for (const [name, callback] of entries) {
      const event = name === 'onClickWait' ? 'onClickWaitIn' : name;
      if ((ARTEMIS_EVENTS as readonly string[]).includes(event))
        this.handlers.set(event as ArtemisEvent, callback);
    }
  }
  /** bf210 empties every callback name (3d98..3e58). */
  clear(): void {
    this.handlers.clear();
  }
  handler(event: ArtemisEvent): string {
    return this.handlers.get(event) ?? '';
  }
  /** Frame/input/save owners decide when to emit; this object does not create a scheduler. */
  emit(event: ArtemisEvent, args: ReadonlyMap<string, string> = new Map()): boolean {
    const callback = this.handler(event);
    if (!callback) return false;
    try {
      this.invoke(callback, args);
    } catch (error) {
      // Native frame/wait owners disable their failed frame or click-wait callback.
      if (
        event === 'onEnterFrame' ||
        event === 'onClickWaitIn' ||
        event === 'onClickWaitOut' ||
        event === 'onSave'
      )
        this.handlers.set(event, '');
      throw error;
    }
    return true;
  }
}
