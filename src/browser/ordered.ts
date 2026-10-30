/**
 * Live printing in timeline order. An action line is only known when the call
 * finishes, but it belongs at the time the call started: so while an action is
 * in flight, everything that follows it is held back and printed right after
 * its line. Lines are ordered by `seq` (actions get theirs at the start), which
 * makes the live output identical to the on-failure block.
 *
 * Nothing is held for long in practice (an action is awaited by the test); a
 * session that ends calls `flush()`, and a backlog beyond `maxHeld` lines is
 * released as-is, so a call that never settles cannot silence the log.
 */
export class OrderedPrinter {
  private entries: Array<{ seq: number; text?: string }> = [];

  constructor(private readonly write: (text: string) => void, private readonly maxHeld = 500) {}

  /** An action (or deferred event) with this `seq` has started; hold later lines until it is `put`. */
  hold(seq: number): void {
    this.insert({ seq });
  }

  /** The line for `seq` is ready. Prints it, and whatever it was holding back, in order. */
  put(seq: number, text: string): void {
    const at = this.entries.findIndex((e) => e.seq === seq);
    if (at !== -1) this.entries[at].text = text;
    else if (this.entries.length === 0) {
      this.write(text);
      return;
    } else this.insert({ seq, text });
    this.drain();
  }

  /** Give up a hold that will never be filled. */
  release(seq: number): void {
    const at = this.entries.findIndex((e) => e.seq === seq);
    if (at === -1) return;
    this.entries.splice(at, 1);
    this.drain();
  }

  /** Print everything that is ready, in order, and forget the unfinished holds. */
  flush(): void {
    const ready = this.entries.filter((e) => e.text !== undefined);
    this.entries = [];
    for (const e of ready) this.write(e.text as string);
  }

  private insert(entry: { seq: number; text?: string }): void {
    let i = this.entries.length;
    while (i > 0 && this.entries[i - 1].seq > entry.seq) i--;
    this.entries.splice(i, 0, entry);
  }

  private drain(): void {
    while (this.entries.length > 0 && this.entries[0].text !== undefined) {
      this.write((this.entries.shift() as { text: string }).text);
    }
    if (this.entries.length > this.maxHeld) this.flush();
  }
}
