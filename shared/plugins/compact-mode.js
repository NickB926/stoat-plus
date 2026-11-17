/**
 * @name Compact Mode
 * @id compact-mode
 * @version 1.0.0
 * @author Stoat+
 * @description Tighter spacing and a smaller font. Example of a CSS plugin.
 * @platforms desktop
 */
definePlugin({
  settings: {
    fontSize: {
      type: "number",
      label: "Font size (px)",
      default: 14,
    },
  },

  start(stoat) {
    let removeCSS = null;
    const apply = () => {
      if (removeCSS) removeCSS();
      const size = Number(stoat.settings.get("fontSize")) || 14;
      removeCSS = stoat.ui.addCSS(`
        :root { font-size: ${size}px; }
        p, li { line-height: 1.3 !important; }
      `);
    };
    apply();
    stoat.settings.onChange(apply);
  },
});
