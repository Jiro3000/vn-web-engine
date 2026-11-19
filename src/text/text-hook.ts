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
  readonly upcoming?: readonly string[];
}

/** The part of the async Clipboard API the hook writes through. */
export interface TextHookClipboard {
  writeText(text: string): Promise<void>;
  write?(items: ClipboardItem[]): Promise<void>;
}

const modes: readonly TextHookMode[] = ['off', 'all', 'unvoiced'];
/** Invisible clipboard signal recognized by Japanese Reader's Speech.js. */
const stopSpeechSignal = '\u2063';
const forecastSignal = '\u2064';
/** Horizontal bars/dashes (――, ——, ──, ━━) that TTS engines read inconsistently. */
const horizontalDash = /[―—─━⸺⸻]+/g;
const beforePausePunct = /^[。、，．,.！？!?…‥\s」』）)\]】]/;
const afterPausePunct = /[。、，．,.！？!?…‥\s「『（(\[【】]$/;
let mode: TextHookMode = 'off';
let writeSequence = 0;

/**
 * Strips decorative horizontal bars/dashes so TTS readers do not pronounce them.
 * Mid-phrase dashes become a brief pause comma; dashes at boundaries or beside
 * punctuation are removed. Katakana prolonged sound marks (`ー`) are kept.
 */
export function sanitizeTextHookText(text: string): string {
  return text
    .replace(horizontalDash, (match, offset: number, source: string) => {
      const before = source.slice(0, offset);
      const after = source.slice(offset + match.length);
      if (!before || !after) return '';
      if (afterPausePunct.test(before) || beforePausePunct.test(after)) return '';
      return '、';
    })
    .trim();
}

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
  const text =
    mode === 'unvoiced' && line.voiced ? stopSpeechSignal : sanitizeTextHookText(line.text);
  if (!text) return false;
  const sequence = ++writeSequence;
  const writePlain = () => {
    if (sequence === writeSequence) void clipboard.writeText(text).catch(() => {});
  };
  if (
    mode !== 'unvoiced' ||
    !line.upcoming?.length ||
    !writeForecast(clipboard, text, line.upcoming, writePlain)
  ) {
    writePlain();
  }
  return true;
}

/** Refreshes future audio while a choice is displayed or a target file finishes loading. */
export function publishTextHookForecast(
  upcoming: readonly string[],
  clipboard: TextHookClipboard | undefined = globalThis.navigator?.clipboard,
): void {
  if (mode === 'unvoiced' && clipboard && writeForecast(clipboard, forecastSignal, upcoming)) {
    writeSequence++;
  }
}

function writeForecast(
  clipboard: TextHookClipboard,
  text: string,
  upcoming: readonly string[],
  onFailure: () => void = () => {},
): boolean {
  if (!clipboard.write || typeof ClipboardItem === 'undefined') return false;
  // Keep regular copy-paste on the plain current line. Reader reads the extra attribute.
  const lines = upcoming
    .slice(0, 16)
    .map(sanitizeTextHookText)
    .filter((next) => next.length > 0 && next.length <= 4096);
  const bytes = new TextEncoder().encode(JSON.stringify(lines));
  const hints = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
  const html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  try {
    void clipboard
      .write([
        new ClipboardItem({
          'text/plain': new Blob([text], {type: 'text/plain'}),
          'text/html': new Blob(
            [
              '<span data-japanese-reader-upcoming="' +
                hints +
                '">' +
                html.replace(/\n/g, '<br>') +
                '</span>',
            ],
            {type: 'text/html'},
          ),
        }),
      ])
      .catch(onFailure);
    return true;
  } catch {
    return false;
  }
}
