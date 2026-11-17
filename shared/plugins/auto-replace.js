/**
 * @name Auto Replace
 * @id auto-replace
 * @version 1.0.0
 * @author Stoat+
 * @description Fixes words in your messages before they're sent, e.g. teh -> the.
 */
definePlugin({
  settings: {
    rules: {
      type: "text",
      label: "Replacements",
      description: "One per line: from = to",
      default: "teh = the\nim = I'm\ndont = don't",
    },
    wholeWords: {
      type: "boolean",
      label: "Whole words only",
      default: true,
    },
  },

  start(stoat) {
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    let rules = [];
    const compile = () => {
      const whole = stoat.settings.get("wholeWords");
      rules = String(stoat.settings.get("rules") || "")
        .split("\n")
        .map((line) => line.split("="))
        .filter((parts) => parts.length >= 2 && parts[0].trim())
        .map(([from, ...to]) => ({
          re: new RegExp(
            whole ? `\\b${escape(from.trim())}\\b` : escape(from.trim()),
            "gi",
          ),
          to: to.join("=").trim(),
        }));
    };
    compile();
    stoat.settings.onChange(compile);

    stoat.onBeforeSend((msg) => {
      // Leave code blocks alone.
      if (msg.content.includes("`")) return;
      let out = msg.content;
      for (const r of rules) out = out.replace(r.re, r.to);
      return out;
    });
  },
});
