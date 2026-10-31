// Text from a Land is shown to the Player only with every control, bidi, invisible, unusual-space,
// unassigned and private-use character as a visible escape, and `\` doubled, so an escape the
// Shell wrote cannot be told from text a Land typed.
const HIDDEN =
  /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Zs}\p{Default_Ignorable_Code_Point}]/u;

const NAMED: Record<string, string> = { "\n": "\\n", "\t": "\\t", "\r": "\\r" };

/** `text` with the characters above as `\u{202e}` (or `\n`, `\t`, `\r`) and `\` as `\\`. */
export function visibleEscapes(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch !== " " && HIDDEN.test(ch))
      out += NAMED[ch] ?? `\\u{${cp.toString(16)}}`;
    else out += ch;
  }
  return out;
}
