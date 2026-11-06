const API = 'https://discord.com/api/v10';

export interface Button {
  type: 2;
  style: 1 | 2 | 3 | 4; // primary, secondary, success, danger
  label: string;
  custom_id: string;
  disabled?: boolean;
}
export interface ActionRow {
  type: 1;
  components: Button[];
}
export interface MessageBody {
  content: string;
  components?: ActionRow[];
  allowed_mentions?: { parse: string[]; users?: string[] };
  message_reference?: { message_id: string };
}

export class DiscordError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Minimal Discord REST client: only the calls the factory uses. */
export class DiscordRest {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        'User-Agent': 'DiscordBot (https://github.com/Peter-Nagy/software-factory, 0.1)',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 3) {
      const wait = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 1);
      await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 50));
      return this.request(method, path, body, attempt + 1);
    }
    if (!res.ok) throw new DiscordError(res.status, `${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  application() {
    return this.request<{ id: string; name: string }>('GET', '/oauth2/applications/@me');
  }

  guildChannels(guildId: string) {
    return this.request<{ id: string; name: string; type: number }[]>('GET', `/guilds/${guildId}/channels`);
  }

  createTextChannel(guildId: string, name: string, topic: string) {
    return this.request<{ id: string }>('POST', `/guilds/${guildId}/channels`, { name, type: 0, topic });
  }

  send(channelId: string, body: MessageBody) {
    // Never ping @everyone/@here or roles from factory text; only explicit user mentions.
    return this.request<{ id: string }>('POST', `/channels/${channelId}/messages`, { allowed_mentions: { parse: [] }, ...body });
  }

  edit(channelId: string, messageId: string, body: Partial<MessageBody>) {
    return this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, body);
  }

  /** Reply to an interaction. type 4 = message, 5 = deferred (thinking...), 7 = update the clicked message. */
  respond(interactionId: string, interactionToken: string, type: 4 | 5 | 7, data?: Partial<MessageBody>) {
    return this.request('POST', `/interactions/${interactionId}/${interactionToken}/callback`, { type, data: data ? { allowed_mentions: { parse: [] }, ...data } : undefined });
  }

  /** Fill in a deferred reply. */
  followUp(applicationId: string, interactionToken: string, content: string) {
    return this.request('PATCH', `/webhooks/${applicationId}/${interactionToken}/messages/@original`, { content, allowed_mentions: { parse: [] } });
  }

  setGuildCommands(applicationId: string, guildId: string, commands: unknown[]) {
    return this.request('PUT', `/applications/${applicationId}/guilds/${guildId}/commands`, commands);
  }
}

/** Discord's message limit is 2000 characters. */
export function clip(text: string, max = 1900): string {
  return text.length <= max ? text : `${text.slice(0, max - 20)}\n… (truncated)`;
}
