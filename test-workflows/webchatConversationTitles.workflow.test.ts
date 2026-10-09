import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { relayResetForTests } from "../src/webchat/relayServer";
import {
  buildPaperConversationTitle,
  claimConversationTitle,
  completeConversationTitle,
  displayedConversationTitle,
  getConversationTitle,
  queueConversationTitle,
  snapshotTitlePaper,
  truncateTitle,
  type PaperTitleSnapshot,
} from "../src/webchat/conversationTitles";

const TABLE = "llm_webchat_conversation_titles";
const RELAY_PREFIX = "/llm-for-zotero/webchat";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

async function callEndpoint(
  path: string,
  opts: { method: string; data?: unknown },
): Promise<Record<string, unknown>> {
  const Endpoint = (
    Zotero.Server.Endpoints as unknown as Record<
      string,
      new () => { init: (options: unknown) => Promise<unknown> }
    >
  )[`${RELAY_PREFIX}${path}`];
  assert.isOk(Endpoint, `relay endpoint ${path} should be registered`);
  const reply = (await new Endpoint().init(opts)) as unknown[];
  return JSON.parse(String(reply[2])) as Record<string, unknown>;
}

async function storedRow(chatUrl: string): Promise<unknown> {
  const rows = await Zotero.DB.queryAsync(
    `SELECT record_json FROM ${TABLE} WHERE chat_url = ?`,
    [chatUrl],
  );
  return rows?.[0] ?? null;
}

async function forget(chatUrl: string): Promise<void> {
  await Zotero.DB.queryAsync(`DELETE FROM ${TABLE} WHERE chat_url = ?`, [
    chatUrl,
  ]);
}

describe("workflow: literature conversation titles", function () {
  this.timeout(60000);
  const newChatUrl = "https://chatgpt.com/c/workflow-titles-new";
  const oldChatUrl = "https://chatgpt.com/c/workflow-titles-old";
  const boundChatUrl = "https://chatgpt.com/c/workflow-titles-bound";
  const paperTitle = "Workflow literature title paper";
  let api: WorkflowTestApi;
  let fixture: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >;
  let paper: PaperTitleSnapshot;

  before(async function () {
    api = getWorkflowTestApi();
    // A previous UI workflow may have left a navigation command in the relay.
    // Title commands deliberately wait until the relay is idle.
    relayResetForTests();
    fixture = await api.createPaperWithPdfFixture({
      title: paperTitle,
      pdfTitle: "Workflow literature title attachment",
    });
    const snapshot = snapshotTitlePaper(Zotero.Items.get(fixture.parentItemId));
    assert.isOk(snapshot, "the real paper should snapshot for naming");
    paper = snapshot!;
  });

  after(async function () {
    for (const chatUrl of [newChatUrl, oldChatUrl, boundChatUrl])
      await forget(chatUrl);
    if (fixture) await api.cleanupFixture(fixture);
    await api.reset();
    relayResetForTests();
  });

  it("names a new conversation once the extension confirms the saved title", async function () {
    assert.equal(paper.title, paperTitle);
    // The fixture carries no creator and no date, so neither may be invented.
    assert.equal(paper.author, "");
    assert.equal(paper.year, "");
    assert.equal(buildPaperConversationTitle(paper), paperTitle);

    const queued = await queueConversationTitle({
      chatUrl: newChatUrl,
      paper,
      expectedTitle: "Generated title",
      automatic: true,
    });
    assert.equal(queued?.status, "queued");
    assert.isOk(
      await storedRow(newChatUrl),
      "the task is durable in zotero.sqlite",
    );
    // A follow-up turn must never rename the conversation again.
    assert.isNull(
      await queueConversationTitle({
        chatUrl: newChatUrl,
        paper,
        expectedTitle: "Generated title",
        automatic: true,
      }),
    );

    const command = await callEndpoint("/poll_title", { method: "GET" });
    const task = command.command as Record<string, unknown>;
    assert.equal(task.type, "RENAME_CHAT");
    assert.equal(task.chatUrl, newChatUrl);
    assert.equal(task.chatId, "workflow-titles-new");
    assert.equal(task.title, paperTitle);
    assert.equal(task.expectedTitle, "Generated title");
    // One mutation slot: the claimed task is not handed out twice.
    const second = await callEndpoint("/poll_title", { method: "GET" });
    assert.isNull(second.command);

    const stale = await callEndpoint("/title_result", {
      method: "POST",
      data: { chatUrl: newChatUrl, operationId: "stale", status: "synced" },
    });
    assert.isFalse(stale.ok);
    const receipt = await callEndpoint("/title_result", {
      method: "POST",
      data: {
        chatUrl: newChatUrl,
        operationId: task.operationId,
        status: "synced",
        title: paperTitle,
      },
    });
    assert.isTrue(receipt.ok);
    const record = await getConversationTitle(newChatUrl);
    assert.equal(record?.status, "synced");
    assert.equal(record?.lastSyncedTitle, paperTitle);
    // After the sync the page owns the title, including a later manual edit.
    assert.equal(
      displayedConversationTitle(record, "Renamed by hand in ChatGPT"),
      "Renamed by hand in ChatGPT",
    );
  });

  it("reads the parent metadata and keeps the snapshot after the paper changes", async function () {
    const attachment = snapshotTitlePaper(
      Zotero.Items.get(fixture.pdfAttachmentId),
    );
    assert.equal(attachment?.title, paperTitle);
    assert.equal(attachment?.itemKey, paper.itemKey);

    await queueConversationTitle({
      chatUrl: boundChatUrl,
      paper,
      expectedTitle: "Generated title",
    });
    const item = Zotero.Items.get(fixture.parentItemId);
    item.setField("title", "Renamed while the answer streamed");
    await item.saveTx();
    try {
      const record = await getConversationTitle(boundChatUrl);
      assert.equal(record?.paper.title, paperTitle);
      assert.equal(record?.title, paperTitle);
    } finally {
      item.setField("title", paperTitle);
      await item.saveTx();
    }

    // Settle this conversation so the next case claims its own task.
    const claimed = await claimConversationTitle();
    assert.equal(claimed?.chatUrl, boundChatUrl);
    await completeConversationTitle({
      chatUrl: boundChatUrl,
      operationId: claimed!.operationId,
      status: "synced",
      title: paperTitle,
    });
  });

  it("lets a user name an existing conversation with the full title kept locally", async function () {
    const longTitle = `Long literature title ${"段".repeat(160)}`;
    const queued = await queueConversationTitle({
      chatUrl: oldChatUrl,
      paper,
      expectedTitle: "Old generated title",
      title: longTitle,
    });
    assert.equal(Array.from(queued!.title).length, 120);
    assert.isTrue(queued!.title.endsWith("…"));
    assert.equal(queued!.title, truncateTitle(longTitle));
    // The untruncated title stays available for the row's tooltip.
    assert.equal(queued!.fullTitle, paperTitle);

    const claimed = await claimConversationTitle();
    assert.equal(claimed?.chatUrl, oldChatUrl);
    await completeConversationTitle({
      chatUrl: oldChatUrl,
      operationId: claimed!.operationId,
      status: "conflict",
      error: "网页标题已改变，请重新预览后命名。",
    });
    const record = await getConversationTitle(oldChatUrl);
    assert.equal(record?.status, "conflict");
    assert.equal(record?.title, truncateTitle(longTitle));
    assert.isOk(await storedRow(oldChatUrl));
  });
});
