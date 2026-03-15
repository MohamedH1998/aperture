/**
 * Composite stability detection script.
 *
 * Injected into pages via page.addInitScript(). Uses 4 independent
 * Web Platform signals to detect when a page has visually settled:
 *
 * 1. MutationObserver — DOM changes quiet for QUIET_PERIOD
 * 2. document.fonts.ready — web fonts finished loading
 * 3. document.getAnimations() — CSS animations finished (excluding infinite)
 * 4. PerformanceObserver layout-shift — no layout shifts for QUIET_PERIOD
 *
 * Exposes window.__apertureStable: Promise<number> that resolves with timestamp.
 */

export const STABILITY_SCRIPT = `(() => {
  const QUIET_PERIOD = 150;
  const HARD_TIMEOUT = 1500;

  let resolveStable;
  let resolved = false;

  window.__apertureStable = new Promise(r => { resolveStable = r; });

  const signals = { dom: false, fonts: false, anims: false, layout: false };
  let quietTimer;

  function done() {
    if (resolved) return;
    if (Object.values(signals).every(Boolean)) {
      resolved = true;
      resolveStable(Date.now());
    }
  }

  function resetQuiet(signal) {
    signals[signal] = false;
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      signals.dom = true;
      signals.layout = true;
      done();
    }, QUIET_PERIOD);
  }

  // 1. DOM mutations
  new MutationObserver(() => resetQuiet('dom'))
    .observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true
    });

  // 2. Font loading
  document.fonts.ready.then(() => { signals.fonts = true; done(); });

  // 3. CSS animations (exclude infinite)
  const checkAnims = () => {
    const running = document.getAnimations().filter(a => {
      const timing = a.effect?.getTiming?.();
      return a.playState === 'running' && isFinite(timing?.iterations ?? 1);
    });
    if (running.length === 0) {
      signals.anims = true;
      done();
    } else {
      Promise.allSettled(running.map(a => a.finished))
        .then(() => { signals.anims = true; done(); });
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(checkAnims));

  // 4. Layout shifts
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      new PerformanceObserver(() => resetQuiet('layout'))
        .observe({ type: 'layout-shift', buffered: true });
    } catch(e) { signals.layout = true; }
  } else {
    signals.layout = true;
  }

  // Hard timeout — don't wait forever
  setTimeout(() => {
    if (!resolved) { resolved = true; resolveStable(Date.now()); }
  }, HARD_TIMEOUT);

  // Kick off initial quiet timer
  resetQuiet('dom');
})();`;
