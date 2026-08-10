export interface Env {
  DB: D1Database;
  DISCORD_PUBLIC_KEY: string;
  /** Only used by the scheduled reconcile job, not by interaction handling. */
  DISCORD_TOKEN: string;
}

/** Discord's ADMINISTRATOR permission bit. */
export const ADMINISTRATOR = 1n << 3n;

export interface InteractionMember {
  user: { id: string; username: string };
  /** Bitfield string of the member's *effective* permissions in this channel. */
  permissions: string;
}

export interface InteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: InteractionOption[];
}

export interface Interaction {
  type: number;
  guild_id?: string;
  member?: InteractionMember;
  user?: { id: string; username: string };
  data?: {
    /** Present on APPLICATION_COMMAND. */
    name?: string;
    options?: InteractionOption[];
    /** Present on MESSAGE_COMPONENT. */
    custom_id?: string;
    component_type?: number;
  };
}

/** Flattens an options array into a name -> value map. */
export function optionMap(
  options: InteractionOption[] | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const o of options ?? []) {
    if (o.value !== undefined) out[o.name] = o.value;
  }
  return out;
}

/** Returns the first subcommand, if the interaction used one. */
export function subcommand(
  options: InteractionOption[] | undefined,
): InteractionOption | undefined {
  return options?.find((o) => o.type === 1 || o.type === 2);
}

export function isAdmin(member: InteractionMember | undefined): boolean {
  if (!member) return false;
  return (BigInt(member.permissions) & ADMINISTRATOR) === ADMINISTRATOR;
}
