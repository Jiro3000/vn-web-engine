// Siglus 1.1.141.3 builds this button order from XInput at 0x6c16f3–0x6c1841.
const standardButtons = [12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 9, 8];

export interface SiglusJoypadSettings {
  swapAB: boolean;
  swapXY: boolean;
}

export class SiglusJoypad {
  private held = new Set<number>();
  private pressed = new Set<number>();
  private released = new Set<number>();
  active = false;
  settings: SiglusJoypadSettings = {swapAB: false, swapXY: false};

  sample(gamepad: Gamepad | undefined): void {
    const held = new Set<number>();
    if (gamepad?.mapping === 'standard') {
      for (const [index, button] of standardButtons.entries()) {
        const swap = button < 2 ? this.settings.swapAB : button < 4 && this.settings.swapXY;
        const input = gamepad.buttons[swap ? button ^ 1 : button];
        if (index === 10 || index === 11 ? (input?.value ?? 0) >= 128 / 255 : input?.pressed)
          held.add(index);
      }
      for (const [stick, x, y] of [[16, 0, 1], [20, 2, 3]] as const) {
        const axisX = gamepad.axes[x] ?? 0;
        const axisY = gamepad.axes[y] ?? 0;
        if (axisY <= -0.5) held.add(stick);
        if (axisY >= 0.5) held.add(stick + 1);
        if (axisX <= -0.5) held.add(stick + 2);
        if (axisX >= 0.5) held.add(stick + 3);
      }
    }
    this.pressed = new Set([...held].filter((index) => !this.held.has(index)));
    this.released = new Set([...this.held].filter((index) => !held.has(index)));
    this.held = held;
    if (!gamepad) this.active = false;
    else if (this.pressed.size) this.active = true;
  }

  state(index: number, command: number): number | undefined {
    // The 1.1.141.3 indexed input receiver at 0x553230 tests the sampled state.
    switch (command) {
      case 1:
        return Number(this.pressed.has(index));
      case 4:
      case 5:
        return Number(this.released.has(index));
      case 6:
        return Number(this.held.has(index));
      case 7:
        return Number(!this.held.has(index));
    }
  }
}
