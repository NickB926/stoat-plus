/**
 * @name Keyword Filter
 * @id keyword-filter
 * @version 1.0.0
 * @author Stoat+
 * @description Hides or censors incoming messages that contain words you list.
 */
definePlugin({
  settings: {
    words: {
      type: "text",
      label: "Words",
      description: "One word or phrase per line",
      default: "",
    },
    mode: {
      type: "select",
      label: "When a message matches",
      options: [
        { value: "censor", label: "Censor the word" },
        { value: "hide", label: "Hide the message" },
      ],
      default: "censor",
    },
  },

  start(stoat) {
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let re = null;
    const compile = () => {
      const words = String(stoat.settings.get("words") || "")
        .split("\n")
        .map((w) => w.trim())
        .filter(Boolean);
      re = words.length
        ? new RegExp(words.map(escape).join("|"), "gi")
        : null;
    };
    compile();
    stoat.settings.onChange(compile);

    stoat.onMessage((msg) => {
      if (!re || !msg.content) return;
      // Never touch your own messages.
      if (msg.authorId && msg.authorId === stoat.self().id) return;
      re.lastIndex = 0;
      if (!re.test(msg.content)) return;
      if (stoat.settings.get("mode") === "hide") return false;
      return msg.content.replace(re, (m) => "\\*".repeat(m.length));
    });
  },
});
