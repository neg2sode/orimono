// Unlimited undo/redo. One gesture = one step: a gesture opens with begin(), may update
// the pattern many times (a swipe, a knob turn), and closes with end().

import type { Pattern } from './model';

export class History {
  private past: Pattern[] = [];
  private future: Pattern[] = [];
  private gestureStart: Pattern | null = null;

  constructor(public current: Pattern, private onChange: (p: Pattern) => void) {}

  /** A complete, one-step edit. Unchanged patterns aren't recorded. */
  apply(next: Pattern) {
    if (next === this.current) return;
    if (this.gestureStart) {
      this.current = next;
    } else {
      this.past.push(this.current);
      this.future = [];
      this.current = next;
    }
    this.onChange(next);
  }

  begin() {
    if (!this.gestureStart) this.gestureStart = this.current;
  }

  end() {
    const start = this.gestureStart;
    this.gestureStart = null;
    if (start && start !== this.current && JSON.stringify(start) !== JSON.stringify(this.current)) {
      this.past.push(start);
      this.future = [];
    }
  }

  undo() {
    this.end();
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.current);
    this.current = prev;
    this.onChange(prev);
  }

  redo() {
    this.end();
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.current);
    this.current = next;
    this.onChange(next);
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}
