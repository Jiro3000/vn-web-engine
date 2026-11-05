/** The single edit control of a modal Win32 input dialog. */
export interface WindowsTextInputRequest {
  readonly caption: string;
  readonly text: string;
  readonly value: string;
  /** EM_LIMITTEXT; null leaves the edit control's default limit. */
  readonly limit: number | null;
}

/** An input box with an OK button and no cancellation path. */
export class BrowserWindowsTextInput {
  constructor(private readonly owner: HTMLElement) {}

  show(request: WindowsTextInputRequest): Promise<string> {
    const document = this.owner.ownerDocument,
      dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', request.caption);
    dialog.style.cssText =
      'max-width:min(36rem,90vw);color:#111;background:#eee;border:1px solid #777;padding:1rem';
    const title = document.createElement('strong'),
      text = document.createElement('p'),
      input = document.createElement('input'),
      button = document.createElement('button');
    title.textContent = request.caption;
    text.textContent = request.text;
    text.style.whiteSpace = 'pre-wrap';
    input.type = 'text';
    input.value = request.value;
    input.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:1rem 0';
    if (request.limit !== null && request.limit > 0) input.maxLength = request.limit;
    button.textContent = 'OK';
    dialog.append(title, text, input, button);
    this.owner.append(dialog);
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    return new Promise((resolve) => {
      const submit = () => {
        const value = input.value;
        dialog.close();
        dialog.remove();
        resolve(value);
      };
      button.addEventListener('click', submit);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          submit();
        }
      });
      dialog.showModal();
      input.focus();
    });
  }
}
