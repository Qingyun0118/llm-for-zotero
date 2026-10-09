import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPaperConversationTitle,
  canonicalTitleChatUrl,
  truncateTitle,
  queueConversationTitle,
  claimConversationTitle,
  completeConversationTitle,
  getConversationTitle,
  displayedConversationTitle,
  snapshotTitlePaper,
  TITLE_TASK_TIMEOUT_MS,
  type PaperTitleSnapshot,
} from "../src/webchat/conversationTitles";

describe("durable WebChat paper titles", function () {
  const original = globalThis.Zotero;
  const paper: PaperTitleSnapshot = {
    libraryID: 1,
    itemKey: "PAPER001",
    title: "Cooperative Control",
    author: "Ma 等",
    year: "2026",
  };
  const url = "https://chatgpt.com/c/chat-1";
  let db: DatabaseSync;
  let directory: string;
  let databasePath: string;
  let tail: Promise<unknown>;
  let serial: number;
  beforeEach(function () {
    directory = mkdtempSync(join(tmpdir(), "webchat-titles-"));
    databasePath = join(directory, "zotero.sqlite");
    db = new DatabaseSync(databasePath);
    tail = Promise.resolve();
    serial = 0;
    globalThis.Zotero = {
      Utilities: { randomString: () => String(++serial) },
      Prefs: { get: () => 23119 },
      Server: { Endpoints: {} },
      DB: {
        executeTransaction: (fn: () => Promise<unknown>) => {
          const result = tail.then(async () => {
            db.exec("BEGIN");
            try {
              const result = await fn();
              db.exec("COMMIT");
              return result;
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
    } as unknown as typeof Zotero;
  });
  afterEach(function () {
    globalThis.Zotero = original;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("formats metadata without inventing missing author/year and truncates Unicode safely", function () {
    assert.equal(
      buildPaperConversationTitle(paper),
      "Ma 等 · 2026 · Cooperative Control",
    );
    assert.equal(
      buildPaperConversationTitle({ ...paper, author: "", year: "" }),
      paper.title,
    );
    assert.equal(Array.from(truncateTitle("😀".repeat(130))).length, 120);
    assert.isTrue(truncateTitle("😀".repeat(130)).endsWith("…"));
    assert.equal(truncateTitle(" title\n  here "), "title here");
    assert.isNull(canonicalTitleChatUrl("https://evil.test/c/chat-1"));
  });

  it("queues an immutable paper snapshot once per conversation", async function () {
    const snapshot = { ...paper };
    await queueConversationTitle({
      chatUrl: url,
      paper: snapshot,
      expectedTitle: "Original",
      automatic: true,
    });
    snapshot.title = "Different paper";
    assert.equal((await getConversationTitle(url))?.paper.title, paper.title);
    assert.isNull(
      await queueConversationTitle({
        chatUrl: url,
        paper: snapshot,
        expectedTitle: "Changed",
        automatic: true,
      }),
    );
    await queueConversationTitle({
      chatUrl: url + "2",
      paper,
      expectedTitle: "Another",
    });
    assert.equal(
      db.prepare("SELECT * FROM llm_webchat_conversation_titles").all().length,
      2,
    );
  });

  it("restores queued work and paper bindings after closing and reopening the database", async function () {
    const queued = await queueConversationTitle({
      chatUrl: url,
      paper,
      expectedTitle: "Original",
    });
    db.close();
    db = new DatabaseSync(databasePath);
    const restored = await getConversationTitle(url);
    assert.deepEqual(restored, queued);
    const claimed = (await claimConversationTitle())!;
    await completeConversationTitle({
      chatUrl: url,
      operationId: claimed.operationId,
      status: "synced",
      title: claimed.title,
    });
    db.close();
    db = new DatabaseSync(databasePath);
    assert.equal((await getConversationTitle(url))?.status, "synced");
    assert.isNull(
      await queueConversationTitle({
        chatUrl: url,
        paper,
        expectedTitle: "Original",
        automatic: true,
      }),
    );
  });

  it("atomically claims one task and ignores stale/mismatched receipts", async function () {
    await queueConversationTitle({
      chatUrl: url,
      paper,
      expectedTitle: "Original",
    });
    const claims = await Promise.all([
      claimConversationTitle(),
      claimConversationTitle(),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const record = claims.find(Boolean)!;
    assert.isFalse(
      await completeConversationTitle({
        chatUrl: url,
        operationId: "stale",
        status: "synced",
        title: record.title,
      }),
    );
    assert.isTrue(
      await completeConversationTitle({
        chatUrl: url,
        operationId: record.operationId,
        status: "synced",
        title: "Wrong",
      }),
    );
    assert.equal((await getConversationTitle(url))?.status, "failed");
  });

  it("waits for a known remote title and persists failures across reads", async function () {
    await queueConversationTitle({ chatUrl: url, paper, expectedTitle: "" });
    assert.isNull(await claimConversationTitle());
    const record = await claimConversationTitle([
      { id: "chat-1", chatUrl: url, title: "Generated title" },
    ]);
    assert.equal(record?.expectedTitle, "Generated title");
    await completeConversationTitle({
      chatUrl: url,
      operationId: record!.operationId,
      status: "conflict",
      error: "Manually changed",
    });
    assert.equal((await getConversationTitle(url))?.status, "conflict");
    assert.isNull(await claimConversationTitle());
  });

  it("keeps pending aliases but respects manual remote edits after successful sync", async function () {
    await queueConversationTitle({
      chatUrl: url,
      paper,
      expectedTitle: "Original",
    });
    assert.equal(
      displayedConversationTitle(await getConversationTitle(url), "Original"),
      buildPaperConversationTitle(paper),
    );
    const record = (await claimConversationTitle())!;
    await completeConversationTitle({
      chatUrl: url,
      operationId: record.operationId,
      status: "synced",
      title: record.title,
    });
    assert.equal(
      displayedConversationTitle(
        await getConversationTitle(url),
        "My manual title",
      ),
      "My manual title",
    );
  });

  it("expires interrupted/offline tasks without automatically replaying them", async function () {
    await queueConversationTitle({
      chatUrl: url,
      paper,
      expectedTitle: "Original",
    });
    const stored = (await getConversationTitle(url))!;
    stored.updatedAt = Date.now() - TITLE_TASK_TIMEOUT_MS - 1;
    db.prepare(
      "UPDATE llm_webchat_conversation_titles SET record_json = ? WHERE chat_url = ?",
    ).run(JSON.stringify(stored), url);
    assert.isNull(await claimConversationTitle());
    assert.equal((await getConversationTitle(url))?.status, "failed");
  });

  for (const scenario of [
    { name: "new ChatGPT chat", shouldName: true },
    { name: "explicit follow-up", expectedChatId: "chat-1", shouldName: false },
    { name: "existing transcript", baseline: 2, shouldName: false },
    { name: "incomplete response", runState: "incomplete", shouldName: false },
    { name: "other provider", target: "deepseek", shouldName: false },
  ]) {
    it(`automatically names only successful new literature chats: ${scenario.name}`, async function () {
      this.timeout(5000);
      const relay = await import("../src/webchat/relayServer");
      const { sendWebChatQuestion } = await import("../src/webchat/pipeline");
      relay.relayResetForTests();
      relay.registerWebChatRelay();
      relay.relaySetExtensionCapabilitiesForTests([
        relay.ATTACHMENT_DELIVERY_CONTRACT_VERSION,
      ]);
      if (scenario.target) {
        const StatusEndpoint = (Zotero.Server.Endpoints as any)[
          "/llm-for-zotero/webchat/extension_status"
        ];
        await new StatusEndpoint().init({
          method: "POST",
          data: {
            ...relay.relayGetExtensionStatus(),
            siteId: scenario.target,
            chatUrl: "https://chat.deepseek.com/",
            url: "https://chat.deepseek.com/",
          },
        });
      }
      let sourceTitle = paper.title;
      const item = {
        libraryID: paper.libraryID,
        key: paper.itemKey,
        firstCreator: paper.author,
        isRegularItem: () => true,
        getField: (field: string) =>
          field === "title" ? sourceTitle : paper.year,
      } as unknown as Zotero.Item;
      const controller = new AbortController();
      const answer = sendWebChatQuestion({
        item,
        question: "Summarize",
        host: "",
        target: scenario.target || "chatgpt",
        expectedChatId: scenario.expectedChatId,
        onAnswerSnapshot: () => {},
        signal: controller.signal,
      });
      // Observe the actual relay dispatch before simulating the browser receipt.
      try {
        for (
          let attempt = 0;
          attempt < 30 && relay.relayGetStateSnapshot().status !== "pending";
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const seq = relay.relayGetStateSnapshot().query.seq;
        const claimed = relay.relayClaimQuery(seq);
        assert.isTrue(claimed.ok);
        sourceTitle = "Metadata edited while answer streams";
        const Endpoint = (Zotero.Server.Endpoints as any)[
          "/llm-for-zotero/webchat/submit_response"
        ];
        const reply = await new Endpoint().init({
          method: "POST",
          data: {
            seq,
            attempt: claimed.query?.attempt || 1,
            response: "The final paper summary",
            run_state: scenario.runState || "done",
            completion_reason: "settled",
            remote_chat_url: scenario.target
              ? "https://chat.deepseek.com/a/chat/s/chat-1"
              : url,
            remote_chat_id: "chat-1",
            baseline_transcript_count: scenario.baseline || 0,
            user_turn_key: "user-1",
            assistant_turn_key: "assistant-1",
            diagnostic: {
              phase: "done",
              siteId: scenario.target || "chatgpt",
              composerTextMatched: true,
              userTurnMatched: true,
              assistantTurnMatched: true,
              attachmentRequested: false,
              submittedAttachmentCount: 0,
              submittedPdfCount: 0,
              attachmentContractVerified: true,
            },
          },
        });
        assert.isTrue(JSON.parse(reply[2]).ok);
        assert.equal((await answer).text, "The final paper summary");
        const title = await getConversationTitle(url);
        if (scenario.shouldName) {
          assert.equal(title?.title, buildPaperConversationTitle(paper));
          assert.equal(title?.paper.title, paper.title);
        } else assert.isNull(title);
      } finally {
        controller.abort();
        relay.relayRequestStop();
        await answer.catch(() => {});
        relay.unregisterWebChatRelay();
      }
    });
  }

  it("uses a PDF parent and rejects unavailable or ambiguous metadata", function () {
    const parent = {
      libraryID: 1,
      key: "PAPER001",
      firstCreator: "Ma 等",
      isRegularItem: () => true,
      getField: (field: string) =>
        field === "title" ? "A paper" : "2026-09-28",
    };
    (globalThis.Zotero as any).Items = { get: () => parent };
    assert.equal(
      snapshotTitlePaper({ parentID: 1 } as Zotero.Item)?.title,
      "A paper",
    );
    assert.isNull(snapshotTitlePaper({ deleted: true } as Zotero.Item));
  });
});
