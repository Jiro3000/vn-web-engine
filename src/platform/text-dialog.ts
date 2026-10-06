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
