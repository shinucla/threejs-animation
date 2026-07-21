/**
 * Status-bar chrome — classic script (no imports) so gear/FPS/mode UI work
 * even if the Three.js module graph fails to load.
 */
(function () {
  const fpsEl = document.getElementById('fps');
  const gearBtn = document.getElementById('gear-btn');
  const gearMenu = document.getElementById('gear-menu');
  const modeLabel = document.getElementById('mode-label');
  const toastEl = document.getElementById('toast');
  const blenderPanel = document.getElementById('blender-panel');

  let frames = 0;
  let last = performance.now();
  let menuOpen = false;
  let currentMode = 'run';

  function setFpsText(text) {
    if (fpsEl) fpsEl.textContent = text;
  }

  function tick(now) {
    frames += 1;
    const elapsed = now - last;
    if (elapsed >= 250) {
      setFpsText(`${Math.round((frames * 1000) / elapsed)} FPS`);
      frames = 0;
      last = now;
    }
    requestAnimationFrame(tick);
  }
  setFpsText('0 FPS');
  requestAnimationFrame(tick);

  function showToast(message, ms = 2200) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toastEl.hidden = true;
    }, ms);
  }

  function setMenuOpen(open) {
    menuOpen = open;
    if (!gearMenu || !gearBtn) return;
    gearMenu.hidden = !open;
    gearBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      const rect = gearBtn.getBoundingClientRect();
      gearMenu.style.top = `${Math.round(rect.bottom + 6)}px`;
      gearMenu.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
    }
  }

  function closeMenu() {
    setMenuOpen(false);
  }

  /** Show/hide chrome for a mode immediately (does not require main.js). */
  function applyModeChrome(mode) {
    if (mode === 'editor') {
      showToast('Editor — coming soon');
      return false;
    }

    currentMode = mode;

    document.body.classList.toggle('mode-blender', mode === 'blender');
    document.body.classList.toggle('mode-run', mode === 'run');

    if (blenderPanel) {
      const show = mode === 'blender';
      blenderPanel.hidden = !show;
      if (show) {
        blenderPanel.removeAttribute('hidden');
        blenderPanel.style.display = 'flex';
      } else {
        blenderPanel.style.display = '';
      }
    }

    const addSheet = document.getElementById('blender-add-sheet');
    if (addSheet && mode !== 'blender') {
      addSheet.hidden = true;
      addSheet.style.display = '';
    }

    if (modeLabel) {
      modeLabel.textContent = mode === 'blender' ? 'Blender' : 'Run';
    }

    for (const btn of gearMenu?.querySelectorAll('[data-mode]') || []) {
      btn.classList.toggle('is-active', btn.dataset.mode === mode);
    }

    window.dispatchEvent(
      new CustomEvent('app:mode-changed', { detail: { mode } }),
    );
    return true;
  }

  if (gearBtn && gearMenu) {
    if (gearMenu.parentElement !== document.body) {
      document.body.appendChild(gearMenu);
    }

    gearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(!menuOpen);
    });

    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!menuOpen) return;
        if (e.target.closest?.('#gear-btn, #gear-menu')) return;
        closeMenu();
      },
      true,
    );

    gearMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mode]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const mode = btn.dataset.mode;
      closeMenu();

      if (!applyModeChrome(mode)) return;

      // Notify the Three.js app (scene swap / blender workspace).
      window.dispatchEvent(
        new CustomEvent('app:set-mode', { detail: { mode } }),
      );
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });

    window.addEventListener('resize', () => {
      if (menuOpen) setMenuOpen(true);
    });
  }

  // Allow main.js to request chrome updates (e.g. restore Run).
  window.addEventListener('app:apply-mode-chrome', (e) => {
    const mode = e.detail?.mode;
    if (mode) applyModeChrome(mode);
  });

  window.addEventListener('app:toast', (e) => {
    showToast(e.detail?.message || '');
  });

  window.__appChrome = {
    showToast,
    setFpsText,
    getMode: () => currentMode,
    applyModeChrome,
    reportError(err) {
      console.error(err);
      setFpsText('ERR');
      showToast(`App failed to load: ${err?.message || err}`, 8000);
    },
  };
})();
