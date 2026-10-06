/** Cursor effects for a selected window/input host. The window owner maps coordinates. */
export interface CursorHost {
  setVisible(visible: boolean): void;
  setPosition(left: number, top: number): void;
}
