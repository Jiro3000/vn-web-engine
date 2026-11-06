/**
 * Some bilingual scenario files put VO2–VO4 at the start of the Japanese
 * ML.TEXT argument. es.ScenarioMacro.ML.TEXT passes that argument to
 * es.ScenarioAddText verbatim. Move the cues into the outer macro stream,
 * where es.ScenarioMacro.VO2–VO4 can dispatch them as usual.
 */
export class YurisScenarioText {
  private blockComment = false;

  normalize(line: string): string {
    // Mask both bytes of a DBCS character. Its second byte can look like syntax.
    const syntax = line.replace(/[\x81-\xfe][\s\S]/g, '\0\0');
    const tokens = /\/\*|\*\/|\/\/|"[^"]*"|'[^']*'|\\ML\.TEXT(?=[ \t]*\()/g;
    const bilingual =
      /[ \t]*\([ \t]*"[^"]*"[ \t]*,[ \t]*"((?:\\VO[234]\([A-Za-z0-9_]*\))+)[^"]*"[ \t]*\)/dy;
    let result = '',
      copied = 0;
    for (let match = tokens.exec(syntax); match; match = tokens.exec(syntax)) {
      const token = match[0];
      if (this.blockComment) {
        // A quote or // has no special meaning inside a block comment.
        const end = syntax.indexOf('*/', match.index);
        if (end === -1) break;
        this.blockComment = false;
        tokens.lastIndex = end + 2;
      } else if (token === '/*') {
        this.blockComment = true;
      } else if (token === '//') {
        break;
      } else if (token === '\\ML.TEXT') {
        bilingual.lastIndex = tokens.lastIndex;
        const text = bilingual.exec(syntax);
        if (!text) continue;
        const [start, end] = text.indices![1]!;
        result +=
          line.slice(copied, match.index) + line.slice(start, end) + line.slice(match.index, start);
        copied = end;
        tokens.lastIndex = bilingual.lastIndex;
      }
    }
    return copied ? result + line.slice(copied) : line;
  }
}
