/**
 * Phone push notifications through ntfy (https://ntfy.sh, or a self-hosted server): the ntfy app subscribes to a
 * topic, and anyone who knows the topic name can read it, so the topic is kept as a secret. Off unless configured.
 */
export type NotifyKind = 'question' | 'alert' | 'info';

export interface PushMessage {
  title: string;
  body: string;
  /** ntfy priority 1-5: 5 breaks through Focus modes, 4 buzzes, 2-3 is quiet. */
  priority: number;
  tags: string[];
  click: string | null;
}

/** What one notification looks like on the phone; null when this kind isn't pushed. */
export function pushFor(kind: NotifyKind, text: string, o: { publicUrl: string | null; info: boolean }): PushMessage | null {
  if (kind === 'info' && !o.info) return null;
  const [first, ...rest] = text.trim().split('\n');
  const title = (first ?? '').length > 90 ? `${first!.slice(0, 87)}…` : first ?? 'Factory';
  const body = (first ?? '').length > 90 ? text.trim() : rest.join('\n').trim() || title;
  const style = {
    question: { priority: 4, tags: ['raising_hand'], prefix: 'Needs you: ' },
    alert: { priority: 5, tags: ['rotating_light'], prefix: '' },
    info: { priority: 2, tags: ['white_check_mark'], prefix: '' },
  }[kind];
  return { title: `${style.prefix}${title}`, body: body.slice(0, 3500), priority: style.priority, tags: style.tags, click: o.publicUrl };
}

/** Header values must be plain ASCII-ish single lines; ntfy reads UTF-8 titles from the X-Title header fine. */
const header = (s: string) => s.replace(/[\r\n]+/g, ' ').slice(0, 250);

export async function sendNtfy(server: string, topic: string, m: PushMessage, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(`${server.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      'X-Title': header(m.title),
      'X-Priority': String(m.priority),
      'X-Tags': m.tags.join(','),
      ...(m.click ? { 'X-Click': m.click } : {}),
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: m.body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
}
