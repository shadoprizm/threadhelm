(function () {
  "use strict";

  const storageKey = "threadhelm-color-theme";
  const choices = new Set(["light", "system", "dark"]);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const root = document.documentElement;

  function storedTheme() {
    try {
      const value = window.localStorage.getItem(storageKey);
      return choices.has(value) ? value : "system";
    } catch {
      return "system";
    }
  }

  function resolvedTheme(theme) {
    return theme === "system" ? (media.matches ? "dark" : "light") : theme;
  }

  function updateControls(theme) {
    document.querySelectorAll("[data-theme-choice]").forEach((button) => {
      const active = button.dataset.themeChoice === theme;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function applyTheme(theme, persist) {
    const choice = choices.has(theme) ? theme : "system";
    const resolved = resolvedTheme(choice);
    root.dataset.theme = choice;
    root.dataset.resolvedTheme = resolved;
    root.style.colorScheme = resolved;

    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor)
      themeColor.content = resolved === "dark" ? "#0d1210" : "#f5f7f6";

    if (persist) {
      try {
        window.localStorage.setItem(storageKey, choice);
      } catch {
        // The selected theme still applies when storage is unavailable.
      }
    }
    updateControls(choice);
  }

  applyTheme(storedTheme(), false);

  document.addEventListener("DOMContentLoaded", () => {
    updateControls(root.dataset.theme || "system");
    document.querySelectorAll("[data-theme-choice]").forEach((button) => {
      button.addEventListener("click", () =>
        applyTheme(button.dataset.themeChoice, true),
      );
    });
  });

  const handleSystemChange = () => {
    if ((root.dataset.theme || "system") === "system")
      applyTheme("system", false);
  };
  if (typeof media.addEventListener === "function")
    media.addEventListener("change", handleSystemChange);
  else media.addListener(handleSystemChange);
})();
