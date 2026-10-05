import os from "node:os";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { VoiceCallRuntime } from "./runtime-entry.js";

let runtimeStub: VoiceCallRuntime;

// mock-isolation: Exercise tool scope without starting real telephony or state services.
vi.mock("./runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(async () => runtimeStub),
}));

import plugin from "./index.js";
import { createVoiceCallRuntime } from "./runtime-entry.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeRuntime(): VoiceCallRuntime {
  const call = {
    callId: "call-1",
    provider: "twilio",
    direction: "outbound",
    state: "active",
    from: "+15550001111",
    to: "+15550001234",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
  } as const;
  return {
    config: { realtime: { enabled: false } } as VoiceCallRuntime["config"],
    provider: {} as VoiceCallRuntime["provider"],
    manager: {
      initiateCall: vi.fn(async () => ({ callId: "new-call", success: true })),
      sendDtmf: vi.fn(async () => ({ success: true })),
      endCall: vi.fn(async () => ({ success: true })),
      getCallForStream: vi.fn(async (callId: string) =>
        callId === call.callId ? call : undefined,
      ),
    } as unknown as VoiceCallRuntime["manager"],
    webhookServer: {} as VoiceCallRuntime["webhookServer"],
    webhookUrl: "http://127.0.0.1:3334/voice/webhook",
    publicUrl: null,
    stop: vi.fn(async () => {}),
  };
}

function registerBoundTool() {
  let toolFactory: ((context: Record<string, unknown>) => unknown) | undefined;
  let registeredService: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  const api = createTestPluginApi({
    id: "voice-call",
    name: "Voice Call",
    description: "test",
    version: "0",
    source: "test",
    registrationMode: "full",
    config: {},
    pluginConfig: { provider: "mock" },
    runtime: { tts: { textToSpeechTelephony: vi.fn() } } as unknown as OpenClawPluginApi["runtime"],
    logger: noopLogger,
    registerGatewayMethod: () => {},
    registerTool: (tool: unknown) => {
      toolFactory =
        typeof tool === "function"
          ? (tool as (context: Record<string, unknown>) => unknown)
          : () => tool;
    },
    registerCli: () => {},
    registerService: (service) => {
      if (service.apiVersion !== 2) {
        throw new Error("Expected scheduler-owned voice-call service");
      }
      registeredService = service;
      service.start({
        config: {},
        stateDir: os.tmpdir(),
        logger: noopLogger,
        scheduler: createTestPluginServiceScheduler(),
      });
    },
    resolvePath: (path: string) => path,
  });
  plugin.register(api);
  if (!registeredService) {
    throw new Error("Expected voice-call service registration");
  }
  if (!toolFactory) {
    throw new Error("Expected voice-call tool registration");
  }
  return {
    service: registeredService,
    tool: toolFactory({
      toolBindings: { voice_call: { kind: "active-call", callId: "call-1" } },
    }) as {
      execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
    },
  };
}

describe("voice-call active-call tool scope", () => {
  beforeEach(() => {
    runtimeStub = makeRuntime();
    vi.mocked(createVoiceCallRuntime)
      .mockReset()
      .mockImplementation(async () => runtimeStub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.voice-call.runtimeCoordinator")
    ];
  });

  it("hangs up the exact active call once through the registered tool", async () => {
    const { tool } = registerBoundTool();

    const result = await tool.execute("end", { action: "end_call" });

    expect(JSON.stringify(result)).not.toContain("error");
    expect(runtimeStub.manager.endCall).toHaveBeenCalledOnce();
    expect(runtimeStub.manager.endCall).toHaveBeenCalledWith("call-1");
  });

  it("rejects a foreign call id without reaching the provider effect", async () => {
    const { tool } = registerBoundTool();

    const result = await tool.execute("foreign", { action: "end_call", callId: "call-2" });

    expect(JSON.stringify(result)).toContain("bound to call");
    expect(runtimeStub.manager.endCall).not.toHaveBeenCalled();
  });

  it.each([
    { action: "continue_call", callId: "call-1", message: "continue" },
    { action: "get_status", callId: "call-1" },
    { action: "initiate_call", message: "start" },
    { action: "send_dtmf", callId: "call-1", digits: "1" },
    { action: "speak_to_user", callId: "call-1", message: "speak" },
  ])("rejects every bound-call action except end_call ($action)", async (params) => {
    const { tool } = registerBoundTool();

    const result = await tool.execute("rejected", params);

    expect(JSON.stringify(result)).toContain("only end_call");
    expect(runtimeStub.manager.endCall).not.toHaveBeenCalled();
    expect(runtimeStub.manager.initiateCall).not.toHaveBeenCalled();
    expect(runtimeStub.manager.sendDtmf).not.toHaveBeenCalled();
  });

  it("finishes an accepted hang-up when the consult is cancelled during call lookup", async () => {
    const { tool } = registerBoundTool();
    const controller = new AbortController();
    const lookupStarted = createDeferred<void>();
    const releaseLookup = createDeferred<void>();
    const call = await runtimeStub.manager.getCallForStream("call-1");
    vi.mocked(runtimeStub.manager.getCallForStream).mockImplementation(async () => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return call;
    });

    const pending = tool.execute("control", { action: "end_call" }, controller.signal);
    await lookupStarted.promise;
    controller.abort();
    releaseLookup.resolve();

    expect(JSON.stringify(await pending)).not.toContain("error");
    expect(runtimeStub.manager.endCall).toHaveBeenCalledOnce();
    expect(runtimeStub.manager.endCall).toHaveBeenCalledWith("call-1");
  });

  it("rejects hang-up before admission when the consult is cancelled or the call has ended", async () => {
    const { tool } = registerBoundTool();
    const controller = new AbortController();
    controller.abort();

    const cancelled = await tool.execute("cancelled", { action: "end_call" }, controller.signal);
    expect(JSON.stringify(cancelled)).toContain("error");

    vi.mocked(runtimeStub.manager.getCallForStream).mockResolvedValue(undefined);
    const ended = await tool.execute("ended", { action: "end_call" });
    expect(JSON.stringify(ended)).toContain("no longer active");
    expect(runtimeStub.manager.endCall).not.toHaveBeenCalled();
  });

  it("rejects a bound hang-up after its service registration is retired", async () => {
    const { service, tool } = registerBoundTool();

    await service.stop?.({} as never);
    const result = await tool.execute("retired", { action: "end_call" });

    expect(JSON.stringify(result)).toContain("retired");
    expect(runtimeStub.manager.endCall).not.toHaveBeenCalled();
  });

  it("rejects a bound hang-up after a replacement service takes ownership", async () => {
    const runtimeA = runtimeStub;
    const { tool } = registerBoundTool();
    runtimeStub = makeRuntime();
    registerBoundTool();

    const result = await tool.execute("replaced", { action: "end_call" });

    expect(JSON.stringify(result)).toContain("no longer active");
    expect(runtimeA.manager.endCall).not.toHaveBeenCalled();
    expect(runtimeStub.manager.endCall).not.toHaveBeenCalled();
  });
});
