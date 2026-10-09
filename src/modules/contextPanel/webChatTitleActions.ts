import { createElement } from "../../utils/domHelpers";
import { registerAddonInPanelDialog } from "../../utils/dialogRegistry";
import { showConversationRenameDialog } from "./conversationRenameDialog";
import { listAllItemCandidates, searchAllItemCandidates } from "./paperSearch";
import {
  buildPaperConversationTitle,
  displayedConversationTitle,
  canonicalTitleChatUrl,
  getConversationTitle,
  queueConversationTitle,
  snapshotTitlePaper,
  truncateTitle,
  type PaperTitleSnapshot,
  type TitleHistorySession,
} from "../../webchat/conversationTitles";

async function choosePaper(
  doc: Document,
  libraryID: number,
  bound?: PaperTitleSnapshot,
): Promise<PaperTitleSnapshot | null> {
  return new Promise((resolve) => {
    const overlay = createElement(doc, "div", "llm-modal-overlay");
    const dialog = createElement(doc, "div", "llm-modal-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "选择此对话对应的文献");
    const heading = createElement(doc, "div", "llm-modal-title", {
      textContent: "选择此对话对应的文献",
    });
    const search = createElement(
      doc,
      "input",
      "llm-conversation-rename-input",
      { type: "search", placeholder: "搜索论文标题、作者或年份" },
    ) as HTMLInputElement;
    search.setAttribute("aria-label", "搜索文献");
    const results = createElement(doc, "div", "");
    results.style.cssText =
      "max-height:280px;overflow:auto;display:flex;flex-direction:column;gap:6px;margin:12px 0";
    const cancel = createElement(doc, "button", "llm-modal-btn", {
      type: "button",
      textContent: "取消",
    });
    dialog.append(heading, search, results, cancel);
    overlay.append(dialog);
    let closed = false;
    let serial = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unregister = () => {};
    const previousFocus = doc.activeElement as HTMLElement | null;
    const finish = (paper: PaperTitleSnapshot | null) => {
      if (closed) return;
      closed = true;
      serial++;
      if (timer) clearTimeout(timer);
      unregister();
      doc.removeEventListener("keydown", escape, true);
      overlay.remove();
      previousFocus?.focus?.();
      resolve(paper);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
    };
    const addPaper = (paper: PaperTitleSnapshot, prefix = "") => {
      const button = createElement(doc, "button", "llm-modal-btn", {
        type: "button",
        textContent: prefix + buildPaperConversationTitle(paper),
      });
      button.style.textAlign = "start";
      button.addEventListener("click", () => finish(paper));
      results.append(button);
    };
    const refresh = async () => {
      const request = ++serial;
      results.textContent = "正在搜索…";
      try {
        const candidates = search.value.trim()
          ? await searchAllItemCandidates(libraryID, search.value, 30)
          : await listAllItemCandidates(libraryID, 30);
        if (closed || request !== serial) return;
        results.textContent = "";
        const seen = new Set<string>();
        if (bound && !search.value.trim()) {
          const existing = Zotero.Items.getByLibraryAndKey(
            bound.libraryID,
            bound.itemKey,
          );
          const paper = existing ? snapshotTitlePaper(existing) : null;
          if (paper) {
            addPaper(paper, "已关联：");
            seen.add(`${paper.libraryID}:${paper.itemKey}`);
          }
        }
        for (const candidate of candidates) {
          const paper = snapshotTitlePaper(Zotero.Items.get(candidate.itemId));
          if (!paper || seen.has(`${paper.libraryID}:${paper.itemKey}`))
            continue;
          seen.add(`${paper.libraryID}:${paper.itemKey}`);
          addPaper(paper);
        }
        if (!results.children.length)
          results.textContent = "未找到文献，请换一个关键词。";
      } catch {
        if (!closed && request === serial)
          results.textContent = "文献搜索失败，请重试。";
      }
    };
    search.addEventListener("input", () => {
      serial++;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 250);
    });
    cancel.addEventListener("click", () => finish(null));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null);
    });
    doc.addEventListener("keydown", escape, true);
    unregister = registerAddonInPanelDialog(doc, () => finish(null));
    (doc.body || doc.documentElement).append(overlay);
    search.focus();
    void refresh();
  });
}

/** Both history surfaces use the same controls, status and persistence. */
export function appendWebChatTitleActions(options: {
  doc: Document;
  container: HTMLElement;
  session: TitleHistorySession;
  libraryID: number;
  updateTitle: (title: string, tooltip: string) => void;
}): void {
  const { doc, container, session, libraryID, updateTitle } = options;
  const chatUrl = canonicalTitleChatUrl(session.chatUrl || "");
  if (!chatUrl) return;
  const actions = createElement(doc, "div", "llm-webchat-title-actions");
  actions.style.cssText =
    "display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 8px;font-size:11px";
  const rename = createElement(doc, "button", "llm-modal-btn", {
    type: "button",
    textContent: "按文献命名",
  }) as HTMLButtonElement;
  const retry = createElement(doc, "button", "llm-modal-btn", {
    type: "button",
    textContent: "重试同步",
  }) as HTMLButtonElement;
  const status = createElement(doc, "span", "");
  status.setAttribute("role", "status");
  retry.hidden = true;
  actions.append(rename, retry, status);
  container.append(actions);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let syncing = false;
  let acting = false;
  // Imported lazily: the relay touches the Zotero global at load time, and the
  // panel module graph must stay loadable outside a running Zotero host.
  const remoteTitle = async () => {
    const { relayGetChatHistory } = await import("../../webchat/relayServer");
    return (
      relayGetChatHistory().find(
        (s) => canonicalTitleChatUrl(s.chatUrl || "") === chatUrl,
      )?.title || session.title
    );
  };
  const refresh = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      const record = await getConversationTitle(chatUrl);
      if (!record) return;
      updateTitle(
        displayedConversationTitle(record, await remoteTitle()),
        record.fullTitle,
      );
      status.textContent =
        record.status === "synced"
          ? ""
          : record.status === "queued" || record.status === "syncing"
            ? "标题同步中…"
            : record.status === "conflict"
              ? "标题已改变，请重新命名"
              : "标题未同步";
      status.title = record.error || "";
      if (record.status === "queued") {
        const { relayGetExtensionStatus } =
          await import("../../webchat/relayServer");
        if (relayGetExtensionStatus()?.renameChatSupported === false)
          status.textContent = "请更新并重新加载 Sync for Zotero 以同步标题";
      }
      syncing = record.status === "syncing";
      rename.disabled = acting || syncing;
      retry.hidden = record.status !== "failed";
      if (
        (record.status === "queued" || record.status === "syncing") &&
        actions.isConnected
      ) {
        timer = setTimeout(() => {
          if (actions.isConnected) void refresh();
        }, 2000);
      }
    } catch {
      status.textContent = "标题记录读取失败";
    }
  };
  const act = async (isRetry: boolean) => {
    acting = true;
    rename.disabled = retry.disabled = true;
    try {
      const record = await getConversationTitle(chatUrl);
      if (isRetry && record) {
        // Reuse the original expected value: a retry must not silently bless
        // a title someone changed since the user confirmed it.
        await queueConversationTitle({
          chatUrl,
          paper: record.paper,
          title: record.title,
          expectedTitle: record.expectedTitle,
        });
      } else {
        const expectedTitle = await remoteTitle();
        const paper = await choosePaper(
          doc,
          record?.paper.libraryID || libraryID,
          record?.paper,
        );
        if (!paper) return;
        const title = await showConversationRenameDialog(doc, {
          title: "文献对话标题（同步到 ChatGPT）",
          initialTitle: truncateTitle(buildPaperConversationTitle(paper)),
          confirmLabel: "保存并同步",
          cancelLabel: "取消",
          maxLength: 240,
          maxCodePoints: 120,
        });
        if (title === null) return;
        await queueConversationTitle({ chatUrl, paper, title, expectedTitle });
      }
      await refresh();
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "标题保存失败";
    } finally {
      acting = false;
      rename.disabled = syncing;
      retry.disabled = false;
    }
  };
  rename.addEventListener("click", () => void act(false));
  retry.addEventListener("click", () => void act(true));
  // Run after the caller attaches the row, so pending tasks can watch status.
  timer = setTimeout(() => {
    if (actions.isConnected) void refresh();
  }, 0);
}
