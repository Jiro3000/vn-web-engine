/**
 * Clipboard text hook. A player that knows the dialogue it shows publishes each new line
 * here; when the reader enables the hook, the line is written to the system clipboard, where
 * reading aids such as text-to-speech readers, dictionaries and translators pick it up.
 *
 * In `unvoiced` mode the hook publishes narration and other lines without a voice cue.
 * Voiced lines send a stop signal to the reader.
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
/** Invisible clipboard signal recognized by Japanese Reader's Speech.js. */
const stopSpeechSignal = '\u2063';
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
 * Publishes the line or a stop signal and reports whether it requested a write.
 * The browser accepts the write only while the page has focus; a refused write drops the line.
 */
export function publishTextHookLine(
  line: TextHookLine,
  clipboard: TextHookClipboard | undefined = globalThis.navigator?.clipboard,
): boolean {
  if (mode === 'off' || !line.text || !clipboard) return false;
  clipboard
    .writeText(mode === 'unvoiced' && line.voiced ? stopSpeechSignal : line.text)
    .catch(() => {
      /* An unfocused page or a denied permission loses this line, not the next one. */
    });
  return true;
}
