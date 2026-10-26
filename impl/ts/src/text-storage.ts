// Private storage for a Text Value. Derived facts never change its text, and
// cached arrays are frozen before an internal caller can read them.
import {
  characterBoundaries,
  characterJoinEnd,
  charactersAt,
  isASCII,
  joinNFC,
} from './unicode';

const encoder = new TextEncoder();
type Head = { count: number; text: string };

// A leading flag run, Indic extenders or emoji Extend/ZWJ sequences can carry
// incoming grapheme state beyond the first Character on the right.
const headOf = (text: string, boundaries: readonly number[]): Head => {
  const end = characterJoinEnd(text);
  let count = 1;
  while (boundaries[count]! < end) {
    count++;
  }
  return { count, text: text.slice(0, boundaries[count]) };
};

export class TextStorage {
  readonly ascii: boolean;
  readonly text: string;
  #utf8: number | undefined;
  #count: number | undefined;
  #boundaries: readonly number[] | undefined;
  #characters: readonly string[] | undefined;
  #head: Head | undefined;
  #tail: string | undefined;

  /** Input has already been validated and normalized by the Value constructor. */
  constructor(text: string, ascii = isASCII(text)) {
    this.text = text;
    this.ascii = ascii;
    this.#utf8 = ascii ? text.length : undefined;
  }

  get utf8Length(): number {
    return (this.#utf8 ??= encoder.encode(this.text).length);
  }

  get characterCount(): number {
    if (this.#count === undefined) {
      if (this.ascii) {
        let count = this.text.length;
        for (
          let i = this.text.indexOf('\r\n');
          i >= 0;
          i = this.text.indexOf('\r\n', i + 2)
        ) {
          count--;
        }
        this.#count = count;
      } else {
        this.#count = this.boundaries.length - 1;
      }
    }
    return this.#count;
  }

  get boundaries(): readonly number[] {
    return (this.#boundaries ??= Object.freeze(characterBoundaries(this.text)));
  }

  get characters(): readonly string[] {
    return (this.#characters ??= Object.freeze(
      charactersAt(this.text, this.boundaries),
    ));
  }

  private get head(): Head {
    return (this.#head ??= this.ascii
      ? {
          count: 1,
          text: this.text.slice(0, this.text.startsWith('\r\n') ? 2 : 1),
        }
      : headOf(this.text, this.boundaries));
  }

  private get tail(): string {
    return (this.#tail ??= this.ascii
      ? this.text.slice(this.text.endsWith('\r\n') ? -2 : -1)
      : this.text.slice(this.boundaries.at(-2)));
  }

  concat(right: TextStorage): TextStorage {
    if (!this.text.length) {
      return right;
    }
    if (!right.text.length) {
      return this;
    }
    if (this.ascii && right.ascii) {
      const result = new TextStorage(this.text + right.text, true);
      const crlf =
        this.text.endsWith('\r') && right.text.startsWith('\n') ? 1 : 0;
      result.#count = this.characterCount + right.characterCount - crlf;
      return result;
    }
    const tail = this.tail;
    const head = right.head;
    const joined = joinNFC(tail, head.text);
    const boundaries = characterBoundaries(joined.text);
    const prefix = this.text.slice(0, -tail.length);
    const lead = prefix + joined.text;
    const suffix = right.text.slice(head.text.length);
    const result = new TextStorage(lead + suffix, false);
    result.#utf8 = this.utf8Length + right.utf8Length + joined.utf8Delta;
    // The left tail and right head are replaced by the seam's Characters.
    const seam = boundaries.length - 1;
    result.#count =
      this.characterCount - 1 + (right.characterCount - head.count) + seam;
    result.#tail = suffix.length
      ? right.tail
      : joined.text.slice(boundaries.at(-2));
    result.#head =
      this.head.text.length < this.text.length
        ? this.head
        : headOf(lead, prefix ? characterBoundaries(lead) : boundaries);
    return result;
  }

  /** Half-open Character offsets; a contiguous NFC substring stays NFC. */
  slice(from: number, to: number): TextStorage {
    const boundaries = this.boundaries;
    const result = new TextStorage(
      this.text.slice(boundaries[from], boundaries[to]),
      this.ascii || undefined,
    );
    result.#count = to - from;
    return result;
  }
}
