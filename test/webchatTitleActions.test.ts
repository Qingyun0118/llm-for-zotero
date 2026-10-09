import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeElement, collectFakeText } from "./helpers/fakeDom";
import { appendWebChatTitleActions } from "../src/modules/contextPanel/webChatTitleActions";
import {
  buildPaperConversationTitle,
  claimConversationTitle,
  completeConversationTitle,
  getConversationTitle,
  queueConversationTitle,
  type PaperTitleSnapshot,
} from "../src/webchat/conversationTitles";

const CHAT_URL = "https://chatgpt.com/c/chat-1";
const UPDATED_EXTENSION_HINT = "请更新并重新加载 Sync for Zotero 以同步标题";

/** A chrome document the panel builders can actually append their dialog to. */
function createTitleDocument(): Document {
  const body = new FakeElement("body");
  return {
    createElement: (tagName: string) => new FakeElement(tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      new FakeElement(tagName),
    body,
    documentElement: body,
    activeElement: null,
    defaultView: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Document;
}

describe("WebChat paper title actions", function () {
  const original = globalThis.Zotero;
  const paper: PaperTitleSnapshot = {
    libraryID: 1,
    itemKey: "PAPER001",
    title: "Cooperative Control",
    author: "Ma 等",
    year: "2026",
  };
  let db: DatabaseSync;
  let directory: string;
  let databasePath: string;
  let tail: Promise<unknown>;
  let serial: number;
  /** Whether the row the actions were mounted into is still on screen. */
  let connected = false;

  beforeEach(function () {
    directory = mkdtempSync(join(tmpdir(), "webchat-title-actions-"));
    databasePath = join(directory, "zotero.sqlite");
    db = new DatabaseSync(databasePath);
    tail = Promise.resolve();
    serial = 0;
    connected = true;
    globalThis.Zotero = {
      Utilities: { randomString: () => String(++serial) },
      Prefs: { get: () => 23119 },
      Server: { Endpoints: {} },
      Libraries: { userLibraryID: 1 },
      Items: {
        get: () => undefined,
        getByLibraryAndKey: () => undefined,
      },
      DB: {
        executeTransaction: (fn: () => Promise<unknown>) => {
          const result = tail.then(async () => {
            db.exec("BEGIN");
            try {
              const value = await fn();
              db.exec("COMMIT");
              return value;
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
          });
          tail = result.catch(() => {});
          return result;
        },
        queryAsync: async (sql: string, args: string[] = []) => {
          const statement = db.prepare(sql);
          return /^SELECT/i.test(sql)
            ? statement.all(...args)
            : statement.run(...args);
        },
      },
    } as unknown as Zotero;
  });

  afterEach(function () {
    connected = false;
    globalThis.Zotero = original;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** Mount the history-row controls the two history surfaces share. */
  function mount(session?: {
    id: string;
    title: string;
    chatUrl: string | null;
  }) {
    const doc = createTitleDocument();
    const container = new FakeElement("div");
    const updates: Array<{ title: string; tooltip: string }> = [];
    appendWebChatTitleActions({
      doc,
      container: container as unknown as HTMLElement,
      session: session || {
        id: "chat-1",
        title: "Original",
        chatUrl: CHAT_URL,
      },
      libraryID: 1,
      updateTitle: (title, tooltip) => updates.push({ title, tooltip }),
    });
    const actions = container.children[0];
    // The real row is attached to a document; the fake reports otherwise, and
    // the pending-task poll only re-reads itself while it is on screen.
    if (actions)
      Object.defineProperty(actions, "isConnected", { get: () => connected });
    return { doc, container, actions, updates };
  }

  function controlByText(scope: FakeElement, text: string): FakeElement {
    const control = scope
      .findAllByTag("button")
      .find((child) => child.textContent === text);
    assert.isOk(control, `expected a control labelled ${text}`);
    return control!;
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 40 && !condition(); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    assert.isTrue(condition(), "timed out waiting for the action state");
  }

  /** Poll the stored record until the background action has landed. */
  async function waitForRecord(
    predicate: (
      record: Awaited<ReturnType<typeof getConversationTitle>>,
    ) => boolean,
  ): Promise<Awaited<ReturnType<typeof getConversationTitle>>> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const record = await getConversationTitle(CHAT_URL);
      if (predicate(record)) return record;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.fail("timed out waiting for the stored title record");
  }

  it("leaves history rows of the other providers untouched", function () {
    const { container } = mount({
      id: "s-1",
      title: "DeepSeek chat",
      chatUrl: "https://chat.deepseek.com/a/chat/s/chat-1",
    });
    assert.equal(container.children.length, 0);
  });

  it("requires an explicit paper choice before a conversation is bound", async function () {
    this.timeout(5000);
    const { doc, actions } = mount();
    assert.isOk(actions, "the ChatGPT row should offer the naming action");
    controlByText(actions!, "按文献命名").dispatchFakeEvent("click");
    const body = (doc as unknown as { body: FakeElement }).body;
    await waitFor(() => body.findByClass("llm-modal-overlay") !== null);
    const overlay = body.findByClass("llm-modal-overlay");
    assert.isOk(overlay, "the picker dialog should open");
    assert.include(collectFakeText(overlay), "选择此对话对应的文献");
    // Nothing is bound until the user picks a paper: the open PDF is not one.
    assert.isNull(await getConversationTitle(CHAT_URL));
    controlByText(overlay!, "取消").dispatchFakeEvent("click");
    assert.isNull(body.findByClass("llm-modal-overlay"));
    assert.isNull(await getConversationTitle(CHAT_URL));
  });

  it("shows an unsynced title and retries with the confirmed expectation", async function () {
    this.timeout(5000);
    await queueConversationTitle({
      chatUrl: CHAT_URL,
      paper,
      expectedTitle: "Original",
    });
    const claimed = (await claimConversationTitle())!;
    await completeConversationTitle({
      chatUrl: CHAT_URL,
      operationId: claimed.operationId,
      status: "synced",
      title: "Someone renamed this",
    });
    assert.equal((await getConversationTitle(CHAT_URL))?.status, "failed");

    const { actions } = mount();
    const retry = controlByText(actions!, "重试同步");
    await waitFor(() => retry.hidden === false);
    const status = actions!.children.find(
      (child) => child.getAttribute("role") === "status",
    )!;
    assert.equal(status.textContent, "标题未同步");
    assert.include(status.title, "保存验证");

    retry.dispatchFakeEvent("click");
    const retried = await waitForRecord(
      (record) => record?.status === "queued",
    );
    assert.equal(retried!.title, buildPaperConversationTitle(paper));
    // The retry keeps what the user confirmed instead of blessing the title
    // somebody changed in ChatGPT in the meantime.
    assert.equal(retried!.expectedTitle, "Original");
  });

  it("asks for an extension update when renaming is unsupported", async function () {
    this.timeout(5000);
    await queueConversationTitle({
      chatUrl: CHAT_URL,
      paper,
      expectedTitle: "Original",
    });
    const relay = await import("../src/webchat/relayServer");
    relay.relayResetForTests();
    relay.registerWebChatRelay();
    const Endpoint = (
      Zotero.Server.Endpoints as Record<
        string,
        new () => { init: (opts: unknown) => Promise<unknown> }
      >
    )["/llm-for-zotero/webchat/extension_status"];
    assert.isOk(Endpoint, "the extension status endpoint should be registered");
    await new Endpoint().init({
      method: "POST",
      data: {
        chatTabAlive: true,
        chatUrl: CHAT_URL,
        siteId: "chatgpt",
        renameChatSupported: false,
      },
    });

    const { actions } = mount();
    const status = actions!.children.find(
      (child) => child.getAttribute("role") === "status",
    )!;
    await waitFor(() => status.textContent === UPDATED_EXTENSION_HINT);
  });
});
