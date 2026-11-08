/**
 * Clipboard text hook. A player that knows the dialogue it shows publishes each new line
 * here; when the reader enables the hook, the line is written to the system clipboard, where
 * reading aids such as text-to-speech readers, dictionaries and translators pick it up.
 *
 * `unvoiced` publishes only lines without a voice cue: in a voiced game, the narration and
 * the lines of an unvoiced protagonist.
 */
export type TextHookMode = 'off' | 'all' | 'unvoiced';

export interface TextHookLine {
  readonly text: string;
  /** The game plays a voice with this line. */
  readonly voiced: boolean;
}

/** The part of the async Clipboard API the hook writes through. */
export interface TextHookClipboard {
  writeText(text: string): Promise<void>;
}

const modes: readonly TextHookMode[] = ['off', 'all', 'unvoiced'];
let mode: TextHookMode = 'off';

export function normalizeTextHookMode(value: unknown): TextHookMode {
  return modes.includes(value as TextHookMode) ? (value as TextHookMode) : 'off';
}

export function getTextHookMode(): TextHookMode {
  return mode;
}

export function setTextHookMode(value: TextHookMode): void {
  mode = normalizeTextHookMode(value);
}

/**
 * Writes `line` to the clipboard when the current mode selects it, and tells whether it did.
 * The browser accepts the write only while the page has focus; a refused write drops the line.
 */
export function publishTextHookLine(
  line: TextHookLine,
  clipboard: TextHookClipboard | undefined = globalThis.navigator?.clipboard,
): boolean {
  if (mode === 'off' || (mode === 'unvoiced' && line.voiced) || !line.text || !clipboard)
    return false;
  clipboard.writeText(line.text).catch(() => {
    /* An unfocused page or a denied permission loses this line, not the next one. */
  });
  return true;
}
