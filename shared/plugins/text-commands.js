/**
 * @name Text Commands
 * @id text-commands
 * @version 1.0.0
 * @author Stoat+
 * @description Adds /shrug, /tableflip, /unflip, /lenny and /me.
 */
definePlugin({
  settings: {
    shrug: {
      type: "string",
      label: "Shrug text",
      default: "¯\\_(ツ)_/¯",
    },
  },

  start(stoat) {
    const add = (name, description, suffix) =>
      stoat.commands.register({
        name,
        description,
        // Whatever this returns is sent instead of the command.
        run: (args) => (args ? `${args} ${suffix()}` : suffix()),
      });

    add("shrug", "Appends a shrug", () => stoat.settings.get("shrug"));
    add("tableflip", "Appends (╯°□°)╯︵ ┻━┻", () => "(╯°□°)╯︵ ┻━┻");
    add("unflip", "Appends ┬─┬ノ( º _ ºノ)", () => "┬─┬ノ( º _ ºノ)");
    add("lenny", "Appends ( ͡° ͜ʖ ͡°)", () => "( ͡° ͜ʖ ͡°)");

    stoat.commands.register({
      name: "me",
      description: "Sends your message in italics",
      run: (args) => (args ? `*${args}*` : undefined),
    });
  },
});
