import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";
const normalizerTestLayer = Layer.mergeAll(
  ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-test-" }),
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

describe("normalizeDispatchCommand attachments", () => {
  it.effect("persists a generic file using the payload MIME type and filename extension", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand({
        type: "thread.turn.start",
        commandId: CommandId.make("command-file"),
        threadId: ThreadId.make("thread-file"),
        message: {
          messageId: MessageId.make("message-file"),
          role: "user",
          text: "Inspect this",
          attachments: [
            {
              type: "image",
              name: "report.pdf",
              mimeType: "image/png",
              sizeBytes: 4,
              dataUrl: "data:application/pdf;base64,JVBERg==",
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: clientCreatedAt,
      });
      if (normalized.type !== "thread.turn.start") {
        throw new Error("Expected a thread.turn.start command");
      }

      const attachment = normalized.message.attachments[0];
      expect(attachment).toMatchObject({
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      });
      if (!attachment) throw new Error("Expected a persisted attachment");

      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      expect(
        Buffer.from(
          yield* fileSystem.readFile(path.join(config.attachmentsDir, `${attachment.id}.pdf`)),
        ).toString(),
      ).toBe("%PDF");
    }).pipe(Effect.provide(normalizerTestLayer)),
  );

  it.effect("normalizes uppercase data URL image media types", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand({
        type: "thread.turn.start",
        commandId: CommandId.make("command-uppercase-image"),
        threadId: ThreadId.make("thread-uppercase-image"),
        message: {
          messageId: MessageId.make("message-uppercase-image"),
          role: "user",
          text: "Inspect this",
          attachments: [
            {
              type: "file",
              name: "image.png",
              mimeType: "application/octet-stream",
              sizeBytes: 1,
              dataUrl: "data:IMAGE/PNG;base64,iA==",
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: clientCreatedAt,
      });
      if (normalized.type !== "thread.turn.start") {
        throw new Error("Expected a thread.turn.start command");
      }

      expect(normalized.message.attachments[0]).toMatchObject({
        type: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 1,
      });
    }).pipe(Effect.provide(normalizerTestLayer)),
  );

  it.effect("rejects a data URL media type longer than the persisted contract allows", () =>
    Effect.gen(function* () {
      const error = yield* normalizeDispatchCommand({
        type: "thread.turn.start",
        commandId: CommandId.make("command-long-mime"),
        threadId: ThreadId.make("thread-file"),
        message: {
          messageId: MessageId.make("message-long-mime"),
          role: "user",
          text: "Inspect this",
          attachments: [
            {
              type: "file",
              name: "report.bin",
              mimeType: "application/octet-stream",
              sizeBytes: 1,
              dataUrl: `data:application/${"x".repeat(100)};base64,QQ==`,
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: clientCreatedAt,
      }).pipe(Effect.flip);

      expect(error.message).toContain("invalid media type");
    }).pipe(Effect.provide(normalizerTestLayer)),
  );
});
