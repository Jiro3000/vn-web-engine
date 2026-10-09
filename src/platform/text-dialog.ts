import {MB_OK, MB_OKCANCEL, type WindowsMessageBoxHost} from './windows-message-box.js';

export interface TextDialogRequest {
  readonly title: string;
  readonly message: string;
  readonly canCancel: boolean;
  readonly fontSize: number;
  readonly minimumWidth: number;
  readonly applyDesktopScale: boolean;
}
export interface TextDialogResult {
  /** Native result code supplied by the selected dialog host. */
  readonly result: number;
}

/** Host-owned asynchronous dialog presentation. Completion may also be synchronous. */
export interface TextDialogHost {
  present(request: TextDialogRequest, complete: (result: TextDialogResult) => void): void;
}

/** Text dialogs as message boxes: OK, or OK and Cancel when the request can be cancelled.
 * The result is the pressed button's native ID (IDOK 1, IDCANCEL 2). */
export class MessageBoxTextDialogHost implements TextDialogHost {
  constructor(private readonly messageBoxes: WindowsMessageBoxHost) {}
  present(request: TextDialogRequest, complete: (result: TextDialogResult) => void): void {
    void this.messageBoxes
      .messageBox(request.message, request.title, request.canCancel ? MB_OKCANCEL : MB_OK)
      .then((result) => complete({result}));
  }
}
