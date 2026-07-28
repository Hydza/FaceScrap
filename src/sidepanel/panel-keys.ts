// Keyboard control of the panel: a cursor over the grid, and one key per function.
//
// Every binding is a single printable character with no modifier, which is safe HERE and
// only here — the side panel is its own document, so the page never sees these keys and
// none of them can collide with Facebook's own. The one shortcut that works while you
// are on facebook.com is declared in manifest.json under "commands", where Chrome
// intercepts the combination before the page gets it.
//
// This module owns the cursor and nothing else: every action is a callback the
// controller supplies, so it reads no panel state.

import { KEY_ACTIONS, type KeyAction, type Keymap } from '../shared/settings';
import { byId } from './format';

interface KeyInputs {
  /** The master switch. Off means the arrows and the grid cursor go too — the point of it
   *  is to hand the keyboard back whole to an IME or another extension. */
  enabled: () => boolean;
  keymap: () => Keymap;
  /** True while Settings owns the keyboard. Only openSettings runs then, so its key can
   *  still close the sheet, and the grid's arrows do not fight the sheet's own focus. */
  settingsOpen: () => boolean;
  /** Run one action against the card the cursor is on (undefined when it is on none).
   *  The NODE, not its id: the controller has to paint that card's picked state in
   *  place, and resolving the id back to a node is work this module already did. */
  run: (action: KeyAction, cursor: HTMLElement | undefined) => void;
}

/** The cursor, held as a card id and not as a node: render() tears the grid down and
 *  rebuilds it whenever a capture lands, which would invalidate a node reference — and
 *  that happens every couple of seconds while a tab is capturing. */
let cursorId: string | undefined;

/** The cards the cursor may land on — none unless the grid is laid out. In Now Playing #list
 *  still holds the last grid's cards inside a hidden view, and a card in there cannot take focus.
 *  offsetParent answers "is this laid out at all", so it stays right however the views are
 *  hidden. */
function gridCards(): HTMLElement[] {
  const list = byId('list');
  if (list.offsetParent == null) return [];
  return [...list.querySelectorAll<HTMLElement>('.card[data-card-id]')];
}

function cursorCard(): HTMLElement | undefined {
  return cursorId == null ? undefined : gridCards().find((card) => card.dataset.cardId === cursorId);
}

/** Columns as the grid ACTUALLY laid them out, so a vertical move follows the density
 *  setting without this module reading it. */
function columnCount(): number {
  const declared = getComputedStyle(byId('list')).gridTemplateColumns.split(/\s+/);
  return Math.max(1, declared.filter((part) => part !== '' && part !== 'none').length);
}

function focusCard(card: HTMLElement | undefined): void {
  if (card == null) return;
  cursorId = card.dataset.cardId;
  // preventScroll then scrollIntoView('nearest'): focus()'s own scrolling centres the
  // card, which jumps the list on every step down a long grid.
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'nearest' });
}

/** Move the cursor by `step` cards. Clamped, not wrapped — jumping from the last card
 *  back to the first reads as the list having scrolled somewhere else. */
function moveCursor(cards: HTMLElement[], step: number): void {
  if (cards.length === 0) return;
  const at = cards.findIndex((card) => card.dataset.cardId === cursorId);
  // With no cursor yet, the first arrow press lands on the first card, not the second.
  focusCard(at < 0 ? cards[0] : cards[Math.min(cards.length - 1, Math.max(0, at + step))]);
}

/** Put the cursor back after a grid rebuild, and only if the rebuild is what took the
 *  focus away: a capture landing while the user is in the tray or the nav must not yank
 *  focus into the grid. The cursor's card may be gone — filtered out, or evicted by the
 *  retention cap — and is then simply dropped. */
export function restoreKeyCursor(): void {
  if (cursorId == null) return;
  const card = cursorCard();
  if (card == null) {
    cursorId = undefined;
    return;
  }
  if (document.activeElement === document.body) card.focus({ preventScroll: true });
}

/** Is something typing? A bound key must never eat a character out of a text field —
 *  the filename template and the retention limit are both free text, and ',' is a
 *  default binding. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el == null) return false;
  return el.isContentEditable === true || /^(?:INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export function setupPanelKeys(inputs: KeyInputs): void {
  document.addEventListener('keydown', (e) => {
    // Leave every modified combination to the browser and the OS. It also means a
    // binding can never shadow Ctrl+F, Alt+Left or the extension's own commands.
    if (!inputs.enabled() || e.ctrlKey || e.altKey || e.metaKey || typing(e.target)) return;

    if (!inputs.settingsOpen()) {
      const vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp';
      const columns = vertical ? columnCount() : 1;
      const step =
        e.key === 'ArrowRight' ? 1
        : e.key === 'ArrowLeft' ? -1
        : e.key === 'ArrowDown' ? columns
        : e.key === 'ArrowUp' ? -columns
        : 0;
      // Queried once and passed down, so one arrow press walks the grid once.
      const cards = step === 0 ? [] : gridCards();
      if (cards.length > 0) {
        e.preventDefault();
        moveCursor(cards, step);
        return;
      }
    }

    const keymap = inputs.keymap();
    const pressed = e.key.toLowerCase();
    // '' means the action is unbound (see normalizeKeymap) and must match nothing.
    const action = KEY_ACTIONS.find((name) => keymap[name] !== '' && keymap[name] === pressed);
    if (action == null) return;
    if (inputs.settingsOpen() && action !== 'openSettings') return;
    e.preventDefault();
    inputs.run(action, cursorCard());
  });
}
