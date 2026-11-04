/** The virtual-key high bits exposed by GetAsyncKeyState, fed by DOM keyboard events. */
export function setWindowsVirtualKey(
  state: Uint8Array,
  event: Pick<KeyboardEvent, 'keyCode' | 'code' | 'location'>,
  down: boolean,
): number {
  let key = event.keyCode;
  const side = (
    {
      ShiftLeft: 0xa0,
      ShiftRight: 0xa1,
      ControlLeft: 0xa2,
      ControlRight: 0xa3,
      AltLeft: 0xa4,
      AltRight: 0xa5,
    } as Record<string, number>
  )[event.code];
  if (side !== undefined) key = side;
  else if (key >= 0x10 && key <= 0x12)
    key = 0xa0 + (key - 0x10) * 2 + (event.location === 2 ? 1 : 0);
  if (key <= 0 || key >= state.length) return 0;
  state[key] = down ? 0x80 : 0;
  if (key >= 0xa0 && key <= 0xa5) {
    const pair = (key - 0xa0) >> 1,
      left = 0xa0 + pair * 2;
    key = 0x10 + pair;
    // Releasing one side must not release the aggregate key while its other side is held.
    state[key] = (state[left]! | state[left + 1]!) & 0x80;
  }
  return key;
}
