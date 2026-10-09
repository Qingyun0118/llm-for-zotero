/** Durable metadata: never owned by the ephemeral WebChat conversation catalog. */
export type PaperTitleSnapshot = {
  libraryID: number;
  itemKey: string;
  title: string;
  author: string;
  year: string;
};
export type TitleStatus =
  | "queued"
  | "syncing"
  | "synced"
  | "failed"
  | "conflict";
export type ConversationTitleRecord = {
  chatUrl: string;
  chatId: string;
  paper: PaperTitleSnapshot;
  fullTitle: string;
  title: string;
  expectedTitle: string;
  lastSyncedTitle: string | null;
  operationId: string;
  status: TitleStatus;
  updatedAt: number;
  error: string | null;
};
const TABLE = "llm_webchat_conversation_titles";
export const TITLE_TASK_TIMEOUT_MS = 90_000;

export function normalizeTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .trim();
}
export function truncateTitle(value: string): string {
  const chars = Array.from(normalizeTitle(value));
  return chars.length > 120
    ? chars.slice(0, 119).join("") + "…"
    : chars.join("");
}
export function buildPaperConversationTitle(paper: PaperTitleSnapshot): string {
  return [paper.author, paper.year, paper.title]
    .map(normalizeTitle)
    .filter(Boolean)
    .join(" · ");
}
export function canonicalTitleChatUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/c\/([a-zA-Z0-9-]+)\/?$/);
    return url.origin === "https://chatgpt.com" && match
      ? `${url.origin}/c/${match[1]}`
      : null;
  } catch {
    return null;
  }
}

export function snapshotTitlePaper(
  item: Zotero.Item | null | undefined,
): PaperTitleSnapshot | null {
  if (!item || item.deleted) return null;
  if (item.parentID) item = Zotero.Items.get(item.parentID);
  if (
    !item ||
    item.deleted ||
    !(item.isRegularItem?.() || item.isAttachment?.())
  )
    return null;
  const title = normalizeTitle(
    String(
      item.getField?.("title") ||
        (item as Zotero.Item & { attachmentFilename?: string })
          .attachmentFilename ||
        "",
    ),
  );
  if (!title || !item.key || !item.libraryID) return null;
  return {
    libraryID: item.libraryID,
    itemKey: item.key,
    title,
    author: normalizeTitle(String(item.firstCreator || "")),
    year: String(item.getField?.("date") || "").match(/\b\d{4}\b/)?.[0] || "",
  };
}

async function init(): Promise<void> {
  await Zotero.DB.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (chat_url TEXT PRIMARY KEY, record_json TEXT NOT NULL)`,
  );
}
async function readRecords(): Promise<ConversationTitleRecord[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT record_json FROM ${TABLE}`,
  )) as Array<{ record_json: string }>;
  return (rows || []).map(
    (row) => JSON.parse(row.record_json) as ConversationTitleRecord,
  );
}
async function readRecord(
  chatUrl: string,
): Promise<ConversationTitleRecord | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT record_json FROM ${TABLE} WHERE chat_url = ?`,
    [chatUrl],
  )) as Array<{ record_json: string }>;
  return rows?.[0]
    ? (JSON.parse(rows[0].record_json) as ConversationTitleRecord)
    : null;
}
async function save(record: ConversationTitleRecord): Promise<void> {
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${TABLE} (chat_url, record_json) VALUES (?, ?)`,
    [record.chatUrl, JSON.stringify(record)],
  );
}
async function transaction<T>(work: () => Promise<T>): Promise<T> {
  await init();
  return Zotero.DB.executeTransaction(work);
}
function expire(record: ConversationTitleRecord): boolean {
  if (
    (record.status === "queued" || record.status === "syncing") &&
    Date.now() - record.updatedAt > TITLE_TASK_TIMEOUT_MS
  ) {
    record.status = "failed";
    record.error =
      "标题同步超时；请确认浏览器在线并更新 Sync for Zotero 后重试。";
    return true;
  }
  return false;
}
export async function getConversationTitle(
  chatUrl: string,
): Promise<ConversationTitleRecord | null> {
  return transaction(async () => {
    const record = await readRecord(canonicalTitleChatUrl(chatUrl) || "");
    if (record && expire(record)) await save(record);
    return record;
  });
}

export async function queueConversationTitle(input: {
  chatUrl: string;
  paper: PaperTitleSnapshot;
  expectedTitle: string;
  title?: string;
  automatic?: boolean;
}): Promise<ConversationTitleRecord | null> {
  const chatUrl = canonicalTitleChatUrl(input.chatUrl);
  if (!chatUrl) throw new Error("仅支持 ChatGPT 文献会话命名。");
  return transaction(async () => {
    const existing = await readRecord(chatUrl);
    if (input.automatic && existing) return null;
    if (existing?.status === "syncing" && !expire(existing))
      throw new Error("标题正在同步，请稍后再试。");
    const fullTitle = buildPaperConversationTitle(input.paper);
    const title = truncateTitle(input.title ?? fullTitle);
    if (!title) throw new Error("对话标题不能为空。");
    const record: ConversationTitleRecord = {
      chatUrl,
      chatId: chatUrl.split("/").pop()!,
      paper: { ...input.paper },
      fullTitle,
      title,
      expectedTitle: normalizeTitle(input.expectedTitle),
      lastSyncedTitle: existing?.lastSyncedTitle || null,
      operationId: `${Date.now()}-${Zotero.Utilities.randomString(16)}`,
      status: "queued",
      updatedAt: Date.now(),
      error: null,
    };
    await save(record);
    return record;
  });
}

export async function claimConversationTitle(
  history: TitleHistorySession[] = [],
): Promise<ConversationTitleRecord | null> {
  return transaction(async () => {
    const records = await readRecords();
    for (const record of records) if (expire(record)) await save(record);
    if (records.some((record) => record.status === "syncing")) return null;
    const next = records
      .filter((record) => record.status === "queued")
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!next) return null;
    if (!next.expectedTitle) {
      next.expectedTitle = normalizeTitle(
        history.find(
          (s) => canonicalTitleChatUrl(s.chatUrl || "") === next.chatUrl,
        )?.title || "",
      );
      if (!next.expectedTitle) return null;
    }
    next.status = "syncing";
    next.updatedAt = Date.now();
    await save(next);
    return next;
  });
}

export async function completeConversationTitle(input: {
  chatUrl: string;
  operationId: string;
  status: string;
  title?: string;
  error?: string;
}): Promise<boolean> {
  return transaction(async () => {
    const record = await readRecord(canonicalTitleChatUrl(input.chatUrl) || "");
    if (
      !record ||
      record.operationId !== input.operationId ||
      record.status !== "syncing"
    )
      return false;
    if (
      input.status === "synced" &&
      normalizeTitle(input.title || "") === record.title
    ) {
      record.status = "synced";
      record.lastSyncedTitle = record.title;
      record.error = null;
    } else {
      record.status = input.status === "conflict" ? "conflict" : "failed";
      record.error = input.error || "网页标题未通过保存验证。";
    }
    record.updatedAt = Date.now();
    await save(record);
    return true;
  });
}

export type TitleHistorySession = {
  id: string;
  title: string;
  chatUrl: string | null;
};
export function displayedConversationTitle(
  record: ConversationTitleRecord | null,
  remoteTitle: string,
): string {
  return record && record.status !== "synced" ? record.title : remoteTitle;
}
