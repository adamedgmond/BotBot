import { InteractionResponseType } from "discord-interactions";

const EPHEMERAL = 1 << 6;

export const ComponentType = { ACTION_ROW: 1, BUTTON: 2 } as const;
export const ButtonStyle = { SECONDARY: 2, DANGER: 4 } as const;

export interface Button {
  type: typeof ComponentType.BUTTON;
  style: number;
  label: string;
  custom_id: string;
}

interface ReplyOptions {
  ephemeral?: boolean;
  /**
   * Leaderboards render players as <@id> mentions so names always match the
   * viewer's server nicknames without us caching them. Suppressing mentions
   * keeps that from pinging ten people every time someone checks standings.
   */
  allowMentions?: boolean;
  buttons?: Button[];
}

function payload(content: string, opts: ReplyOptions) {
  return {
    content,
    flags: opts.ephemeral ? EPHEMERAL : 0,
    allowed_mentions: opts.allowMentions ? undefined : { parse: [] },
    components: opts.buttons
      ? [{ type: ComponentType.ACTION_ROW, components: opts.buttons }]
      : [],
  };
}

export function reply(content: string, opts: ReplyOptions = {}): Response {
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: payload(content, opts),
  });
}

/**
 * Replaces the message the component belongs to. Used to retire a confirmation
 * prompt so its button can't be clicked twice.
 */
export function updateMessage(
  content: string,
  opts: ReplyOptions = {},
): Response {
  return Response.json({
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: payload(content, opts),
  });
}

/** A user-facing error that a command handler can throw. */
export class UserError extends Error {}
