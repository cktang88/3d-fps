// Keyboard / mouse input with pointer lock, rebindable actions and per-frame edge detection.

export const DEFAULT_BINDINGS = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  jump: ['Space'],
  sprint: ['ShiftLeft'],
  crouch: ['KeyC', 'ControlLeft'],
  reload: ['KeyR'],
  interact: ['KeyF'],
  fireMode: ['KeyB'],
  melee: ['KeyV'],
  grenade: ['KeyG'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  inspect: ['KeyI'],
  scoreboard: ['Tab'],
  gunsmith: ['KeyT'],
  laser: ['KeyL'],
  fire: ['Mouse0'],
  aim: ['Mouse2'],
};

export class Input {
  constructor(element) {
    this.element = element;
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.locked = false;
    this.enabled = true;
    this.onLockChange = null;

    addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || (e.code === 'Space' && this.locked)) e.preventDefault();
      if (!this.enabled || e.repeat) return;
      this._press(e.code);
    });
    addEventListener('keyup', (e) => this._release(e.code));
    element.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this._press('Mouse' + e.button);
    });
    addEventListener('mouseup', (e) => this._release('Mouse' + e.button));
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Guard against the occasional huge spike some browsers report on lock.
      if (Math.abs(e.movementX) > 600 || Math.abs(e.movementY) > 600) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === element;
      if (!this.locked) this.clear();
      this.onLockChange?.(this.locked);
    });
    addEventListener('blur', () => this.clear());
  }

  lock() {
    const p = this.element.requestPointerLock?.({ unadjustedMovement: true });
    // Fall back when raw input isn't supported.
    if (p && p.catch) p.catch(() => this.element.requestPointerLock());
  }

  unlock() { document.exitPointerLock?.(); }

  _press(code) {
    if (!this.down.has(code)) this.pressed.add(code);
    this.down.add(code);
  }

  _release(code) {
    if (this.down.has(code)) this.released.add(code);
    this.down.delete(code);
  }

  clear() {
    for (const c of this.down) this.released.add(c);
    this.down.clear();
  }

  is(action) { return this.bindings[action]?.some((c) => this.down.has(c)) ?? false; }
  justPressed(action) { return this.bindings[action]?.some((c) => this.pressed.has(c)) ?? false; }
  justReleased(action) { return this.bindings[action]?.some((c) => this.released.has(c)) ?? false; }

  consumeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY, wheel: this.wheel };
    this.mouseDX = this.mouseDY = this.wheel = 0;
    return d;
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
  }
}
