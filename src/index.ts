import { InteractionResponseType, InteractionType, verifyKey } from "discord-interactions";
import { handle, handleComponent } from "./handlers.js";
import { reconcileGuilds } from "./reconcile.js";
import { reply, UserError } from "./respond.js";
import type { Env, Interaction } from "./types.js";

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    try {
      const result = await reconcileGuilds(env.DB, env.DISCORD_TOKEN);
      console.log("guild reconcile", result);
    } catch (err) {
      // Reconcile is the only thing here that deletes data. If it can't
      // establish ground truth it does nothing, and we surface that loudly
      // rather than letting a broken token quietly stop retention cleanup.
      console.error("guild reconcile failed", err);
      throw err;
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("BotBot — Transformers TCG match tracking.", {
        status: 200,
      });
    }

    // Discord validates the endpoint by sending a deliberately bad signature
    // and expecting a 4xx. Read the body once, as text, before parsing.
    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    const body = await request.text();

    const valid =
      signature &&
      timestamp &&
      (await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY));
    if (!valid) {
      return new Response("Bad request signature.", { status: 401 });
    }

    const interaction = JSON.parse(body) as Interaction;

    if (interaction.type === InteractionType.PING) {
      return Response.json({ type: InteractionResponseType.PONG });
    }

    const isCommand = interaction.type === InteractionType.APPLICATION_COMMAND;
    const isComponent = interaction.type === InteractionType.MESSAGE_COMPONENT;
    if (!isCommand && !isComponent) {
      return new Response("Unsupported interaction type.", { status: 400 });
    }

    try {
      return isCommand
        ? await handle(interaction, env)
        : await handleComponent(interaction, env);
    } catch (err) {
      if (err instanceof UserError) {
        return reply(err.message, { ephemeral: true });
      }
      console.error("command failed", {
        command: interaction.data?.name,
        guild: interaction.guild_id,
        err,
      });
      return reply("Something went wrong on my end. Try again in a moment.", {
        ephemeral: true,
      });
    }
  },
} satisfies ExportedHandler<Env>;
