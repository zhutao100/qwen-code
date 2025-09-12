/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CoreToolScheduler,
  ToolCall,
  WaitingToolCall,
  convertToFunctionResponse,
} from './coreToolScheduler.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
  ToolInvocation,
  ToolResult,
  Config,
  Kind,
  ApprovalMode,
  ToolResultDisplay,
  ToolRegistry,
} from '../index.js';
import { Part, PartListUnion } from '@google/genai';
import { MockModifiableTool, MockTool } from '../test-utils/tools.js';

class TestApprovalTool extends BaseDeclarativeTool<{ id: string }, ToolResult> {
  static readonly Name = 'testApprovalTool';

  constructor(private config: Config) {
    super(
      TestApprovalTool.Name,
      'TestApprovalTool',
      'A tool for testing approval logic',
      Kind.Edit,
      {
        properties: { id: { type: 'string' } },
        required: ['id'],
        type: 'object',
      },
    );
  }

  protected createInvocation(params: {
    id: string;
  }): ToolInvocation<{ id: string }, ToolResult> {
    return new TestApprovalInvocation(this.config, params);
  }
}

class TestApprovalInvocation extends BaseToolInvocation<
  { id: string },
  ToolResult
> {
  constructor(
    private config: Config,
    params: { id: string },
  ) {
    super(params);
  }

  getDescription(): string {
    return `Test tool ${this.params.id}`;
  }

  override async shouldConfirmExecute(): Promise<
    ToolCallConfirmationDetails | false
  > {
    // Need confirmation unless approval mode is AUTO_EDIT
    if (this.config.getApprovalMode() === ApprovalMode.AUTO_EDIT) {
      return false;
    }

    return {
      type: 'edit',
      title: `Confirm Test Tool ${this.params.id}`,
      fileName: `test-${this.params.id}.txt`,
      filePath: `/test-${this.params.id}.txt`,
      fileDiff: 'Test diff content',
      originalContent: '',
      newContent: 'Test content',
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
        }
      },
    };
  }

  async execute(): Promise<ToolResult> {
    return {
      llmContent: `Executed test tool ${this.params.id}`,
      returnDisplay: `Executed test tool ${this.params.id}`,
    };
  }
}

describe('CoreToolScheduler', () => {
  it('should cancel a tool call if the signal is aborted before confirmation', async () => {
    const mockTool = new MockTool();
    mockTool.shouldConfirm = true;
    const declarativeTool = mockTool;
    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByName: () => declarativeTool,
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'oauth-personal',
      }),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      toolRegistry: mockToolRegistry,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'mockTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-1',
    };

    abortController.abort();
    await scheduler.schedule([request], abortController.signal);

    expect(onAllToolCallsComplete).toHaveBeenCalled();
    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('cancelled');
  });
});

describe('CoreToolScheduler with payload', () => {
  it('should update args and diff and execute tool when payload is provided', async () => {
    const mockTool = new MockModifiableTool();
    const declarativeTool = mockTool;
    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByName: () => declarativeTool,
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'oauth-personal',
      }),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      toolRegistry: mockToolRegistry,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'mockModifiableTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-2',
    };

    await scheduler.schedule([request], abortController.signal);

    await vi.waitFor(() => {
      const awaitingCall = onToolCallsUpdate.mock.calls.find(
        (call) => call[0][0].status === 'awaiting_approval',
      )?.[0][0];
      expect(awaitingCall).toBeDefined();
    });

    const awaitingCall = onToolCallsUpdate.mock.calls.find(
      (call) => call[0][0].status === 'awaiting_approval',
    )?.[0][0];
    const confirmationDetails = awaitingCall.confirmationDetails;

    if (confirmationDetails) {
      const payload: ToolConfirmationPayload = { newContent: 'final version' };
      await confirmationDetails.onConfirm(
        ToolConfirmationOutcome.ProceedOnce,
        payload,
      );
    }

    expect(onAllToolCallsComplete).toHaveBeenCalled();
    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('success');
    expect(mockTool.executeFn).toHaveBeenCalledWith({
      newContent: 'final version',
    });
  });
});

describe('convertToFunctionResponse', () => {
  const toolName = 'testTool';
  const callId = 'call1';

  it('should handle simple string llmContent', () => {
    const llmContent = 'Simple text output';
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual({
      functionResponse: {
        name: toolName,
        id: callId,
        response: { output: 'Simple text output' },
      },
    });
  });

  it('should handle llmContent as a single Part with text', () => {
    const llmContent: Part = { text: 'Text from Part object' };
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual({
      functionResponse: {
        name: toolName,
        id: callId,
        response: { output: 'Text from Part object' },
      },
    });
  });

  it('should handle llmContent as a PartListUnion array with a single text Part', () => {
    const llmContent: PartListUnion = [{ text: 'Text from array' }];
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual({
      functionResponse: {
        name: toolName,
        id: callId,
        response: { output: 'Text from array' },
      },
    });
  });

  it('should handle llmContent with inlineData', () => {
    const llmContent: Part = {
      inlineData: { mimeType: 'image/png', data: 'base64...' },
    };
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: {
            output: 'Binary content of type image/png was processed.',
          },
        },
      },
      llmContent,
    ]);
  });

  it('should handle llmContent with fileData', () => {
    const llmContent: Part = {
      fileData: { mimeType: 'application/pdf', fileUri: 'gs://...' },
    };
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: {
            output: 'Binary content of type application/pdf was processed.',
          },
        },
      },
      llmContent,
    ]);
  });

  it('should handle llmContent as an array of multiple Parts (text and inlineData)', () => {
    const llmContent: PartListUnion = [
      { text: 'Some textual description' },
      { inlineData: { mimeType: 'image/jpeg', data: 'base64data...' } },
      { text: 'Another text part' },
    ];
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual({
      functionResponse: {
        name: toolName,
        id: callId,
        response: { output: 'Some textual descriptionAnother text part' },
      },
    });
  });

  it('should handle llmContent as an array with a single inlineData Part', () => {
    const llmContent: PartListUnion = [
      { inlineData: { mimeType: 'image/gif', data: 'gifdata...' } },
    ];
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual([
      {
        functionResponse: {
          name: toolName,
          id: callId,
          response: {
            output: 'Binary content of type image/gif was processed.',
          },
        },
      },
      ...llmContent,
    ]);
  });

  it('should handle llmContent as a generic Part (not text, inlineData, or fileData)', () => {
    const llmContent: Part = { functionCall: { name: 'test', args: {} } };
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual({
      functionResponse: {
        name: toolName,
        id: callId,
        response: { output: 'Tool execution succeeded.' },
      },
    });
  });

  it('should handle empty string llmContent', () => {
    const llmContent = '';
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual({
      functionResponse: {
        name: toolName,
        id: callId,
        response: { output: '' },
      },
    });
  });

  it('should handle llmContent as an empty array', () => {
    const llmContent: PartListUnion = [];
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual({
      functionResponse: {
        name: toolName,
        id: callId,
        response: { output: '' },
      },
    });
  });

  it('should handle llmContent as a Part with undefined inlineData/fileData/text', () => {
    const llmContent: Part = {}; // An empty part object
    const result = convertToFunctionResponse(toolName, callId, llmContent);
    expect(result).toEqual({
      functionResponse: {
        name: toolName,
        id: callId,
        response: { output: 'Tool execution succeeded.' },
      },
    });
  });
});

class MockEditToolInvocation extends BaseToolInvocation<
  Record<string, unknown>,
  ToolResult
> {
  constructor(params: Record<string, unknown>) {
    super(params);
  }

  getDescription(): string {
    return 'A mock edit tool invocation';
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    return {
      type: 'edit',
      title: 'Confirm Edit',
      fileName: 'test.txt',
      filePath: 'test.txt',
      fileDiff:
        '--- test.txt\n+++ test.txt\n@@ -1,1 +1,1 @@\n-old content\n+new content',
      originalContent: 'old content',
      newContent: 'new content',
      onConfirm: async () => {},
    };
  }

  async execute(_abortSignal: AbortSignal): Promise<ToolResult> {
    return {
      llmContent: 'Edited successfully',
      returnDisplay: 'Edited successfully',
    };
  }
}

class MockEditTool extends BaseDeclarativeTool<
  Record<string, unknown>,
  ToolResult
> {
  constructor() {
    super('mockEditTool', 'mockEditTool', 'A mock edit tool', Kind.Edit, {});
  }

  protected createInvocation(
    params: Record<string, unknown>,
  ): ToolInvocation<Record<string, unknown>, ToolResult> {
    return new MockEditToolInvocation(params);
  }
}

describe('CoreToolScheduler edit cancellation', () => {
  it('should preserve diff when an edit is cancelled', async () => {
    const mockEditTool = new MockEditTool();
    const declarativeTool = mockEditTool;
    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByName: () => declarativeTool,
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'oauth-personal',
      }),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      toolRegistry: mockToolRegistry,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'mockEditTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-1',
    };

    await scheduler.schedule([request], abortController.signal);

    // Wait for the tool to reach awaiting_approval state
    const awaitingCall = onToolCallsUpdate.mock.calls.find(
      (call) => call[0][0].status === 'awaiting_approval',
    )?.[0][0];

    expect(awaitingCall).toBeDefined();

    // Cancel the edit
    const confirmationDetails = awaitingCall.confirmationDetails;
    if (confirmationDetails) {
      await confirmationDetails.onConfirm(ToolConfirmationOutcome.Cancel);
    }

    expect(onAllToolCallsComplete).toHaveBeenCalled();
    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];

    expect(completedCalls[0].status).toBe('cancelled');

    // Check that the diff is preserved
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cancelledCall = completedCalls[0] as any;
    expect(cancelledCall.response.resultDisplay).toBeDefined();
    expect(cancelledCall.response.resultDisplay.fileDiff).toBe(
      '--- test.txt\n+++ test.txt\n@@ -1,1 +1,1 @@\n-old content\n+new content',
    );
    expect(cancelledCall.response.resultDisplay.fileName).toBe('test.txt');
  });
});

describe('CoreToolScheduler YOLO mode', () => {
  it('should execute tool requiring confirmation directly without waiting', async () => {
    // Arrange
    const mockTool = new MockTool();
    mockTool.executeFn.mockReturnValue({
      llmContent: 'Tool executed',
      returnDisplay: 'Tool executed',
    });
    // This tool would normally require confirmation.
    mockTool.shouldConfirm = true;
    const declarativeTool = mockTool;

    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getToolByName: () => declarativeTool,
      // Other properties are not needed for this test but are included for type consistency.
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    // Configure the scheduler for YOLO mode.
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.YOLO,
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'oauth-personal',
      }),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      toolRegistry: mockToolRegistry,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'mockTool',
      args: { param: 'value' },
      isClientInitiated: false,
      prompt_id: 'prompt-id-yolo',
    };

    // Act
    await scheduler.schedule([request], abortController.signal);

    // Assert
    // 1. The tool's execute method was called directly.
    expect(mockTool.executeFn).toHaveBeenCalledWith({ param: 'value' });

    // 2. The tool call status never entered 'awaiting_approval'.
    const statusUpdates = onToolCallsUpdate.mock.calls
      .map((call) => (call[0][0] as ToolCall)?.status)
      .filter(Boolean);
    expect(statusUpdates).not.toContain('awaiting_approval');
    expect(statusUpdates).toEqual([
      'validating',
      'scheduled',
      'executing',
      'success',
    ]);

    // 3. The final callback indicates the tool call was successful.
    expect(onAllToolCallsComplete).toHaveBeenCalled();
    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls).toHaveLength(1);
    const completedCall = completedCalls[0];
    expect(completedCall.status).toBe('success');
    if (completedCall.status === 'success') {
      expect(completedCall.response.resultDisplay).toBe('Tool executed');
    }
  });
});

describe('CoreToolScheduler cancellation during executing with live output', () => {
  it('sets status to cancelled and preserves last output', async () => {
    class StreamingInvocation extends BaseToolInvocation<
      { id: string },
      ToolResult
    > {
      getDescription(): string {
        return `Streaming tool ${this.params.id}`;
      }

      async execute(
        signal: AbortSignal,
        updateOutput?: (output: ToolResultDisplay) => void,
      ): Promise<ToolResult> {
        updateOutput?.('hello');
        // Wait until aborted to emulate a long-running task
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });
        // Return a normal (non-error) result; scheduler should still mark cancelled
        return { llmContent: 'done', returnDisplay: 'done' };
      }
    }

    class StreamingTool extends BaseDeclarativeTool<
      { id: string },
      ToolResult
    > {
      constructor() {
        super(
          'stream-tool',
          'Stream Tool',
          'Emits live output and waits for abort',
          Kind.Other,
          {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
          true,
          true,
        );
      }
      protected createInvocation(params: { id: string }) {
        return new StreamingInvocation(params);
      }
    }

    const tool = new StreamingTool();
    const mockToolRegistry = {
      getTool: () => tool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByName: () => tool,
      getToolByDisplayName: () => tool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'oauth-personal',
      }),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      toolRegistry: mockToolRegistry,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request = {
      callId: '1',
      name: 'stream-tool',
      args: { id: 'x' },
      isClientInitiated: true,
      prompt_id: 'prompt-stream',
    };

    const schedulePromise = scheduler.schedule(
      [request],
      abortController.signal,
    );

    // Wait until executing
    await vi.waitFor(() => {
      const calls = onToolCallsUpdate.mock.calls;
      const last = calls[calls.length - 1]?.[0][0] as ToolCall | undefined;
      expect(last?.status).toBe('executing');
    });

    // Now abort
    abortController.abort();

    await schedulePromise;

    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
    });
    const completedCalls = onAllToolCallsComplete.mock
      .calls[0][0] as ToolCall[];
    expect(completedCalls[0].status).toBe('cancelled');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cancelled: any = completedCalls[0];
    expect(cancelled.response.resultDisplay).toBe('hello');
  });
});

describe('CoreToolScheduler request queueing', () => {
  it('should queue a request if another is running', async () => {
    let resolveFirstCall: (result: ToolResult) => void;
    const firstCallPromise = new Promise<ToolResult>((resolve) => {
      resolveFirstCall = resolve;
    });

    const mockTool = new MockTool();
    mockTool.executeFn.mockImplementation(() => firstCallPromise);
    const declarativeTool = mockTool;

    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getToolByName: () => declarativeTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.YOLO, // Use YOLO to avoid confirmation prompts
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'oauth-personal',
      }),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      toolRegistry: mockToolRegistry,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request1 = {
      callId: '1',
      name: 'mockTool',
      args: { a: 1 },
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    };
    const request2 = {
      callId: '2',
      name: 'mockTool',
      args: { b: 2 },
      isClientInitiated: false,
      prompt_id: 'prompt-2',
    };

    // Schedule the first call, which will pause execution.
    scheduler.schedule([request1], abortController.signal);

    // Wait for the first call to be in the 'executing' state.
    await vi.waitFor(() => {
      const calls = onToolCallsUpdate.mock.calls.at(-1)?.[0] as ToolCall[];
      expect(calls?.[0]?.status).toBe('executing');
    });

    // Schedule the second call while the first is "running".
    const schedulePromise2 = scheduler.schedule(
      [request2],
      abortController.signal,
    );

    // Ensure the second tool call hasn't been executed yet.
    expect(mockTool.executeFn).toHaveBeenCalledTimes(1);
    expect(mockTool.executeFn).toHaveBeenCalledWith({ a: 1 });

    // Complete the first tool call.
    resolveFirstCall!({
      llmContent: 'First call complete',
      returnDisplay: 'First call complete',
    });

    // Wait for the second schedule promise to resolve.
    await schedulePromise2;

    // Wait for the second call to be in the 'executing' state.
    await vi.waitFor(() => {
      const calls = onToolCallsUpdate.mock.calls.at(-1)?.[0] as ToolCall[];
      expect(calls?.[0]?.status).toBe('executing');
    });

    // Now the second tool call should have been executed.
    expect(mockTool.executeFn).toHaveBeenCalledTimes(2);
    expect(mockTool.executeFn).toHaveBeenCalledWith({ b: 2 });

    // Let the second call finish.
    const secondCallResult = {
      llmContent: 'Second call complete',
      returnDisplay: 'Second call complete',
    };
    // Since the mock is shared, we need to resolve the current promise.
    // In a real scenario, a new promise would be created for the second call.
    resolveFirstCall!(secondCallResult);

    // Wait for the second completion.
    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalledTimes(2);
    });

    // Verify the completion callbacks were called correctly.
    expect(onAllToolCallsComplete.mock.calls[0][0][0].status).toBe('success');
    expect(onAllToolCallsComplete.mock.calls[1][0][0].status).toBe('success');
  });

  it('should handle two synchronous calls to schedule', async () => {
    const mockTool = new MockTool();
    const declarativeTool = mockTool;
    const mockToolRegistry = {
      getTool: () => declarativeTool,
      getToolByName: () => declarativeTool,
      getFunctionDeclarations: () => [],
      tools: new Map(),
      discovery: {},
      registerTool: () => {},
      getToolByDisplayName: () => declarativeTool,
      getTools: () => [],
      discoverTools: async () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
    } as unknown as ToolRegistry;

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();

    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => ApprovalMode.YOLO,
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'oauth-personal',
      }),
    } as unknown as Config;

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      toolRegistry: mockToolRegistry,
      onAllToolCallsComplete,
      onToolCallsUpdate,
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();
    const request1 = {
      callId: '1',
      name: 'mockTool',
      args: { a: 1 },
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    };
    const request2 = {
      callId: '2',
      name: 'mockTool',
      args: { b: 2 },
      isClientInitiated: false,
      prompt_id: 'prompt-2',
    };

    // Schedule two calls synchronously.
    const schedulePromise1 = scheduler.schedule(
      [request1],
      abortController.signal,
    );
    const schedulePromise2 = scheduler.schedule(
      [request2],
      abortController.signal,
    );

    // Wait for both promises to resolve.
    await Promise.all([schedulePromise1, schedulePromise2]);

    // Ensure the tool was called twice with the correct arguments.
    expect(mockTool.executeFn).toHaveBeenCalledTimes(2);
    expect(mockTool.executeFn).toHaveBeenCalledWith({ a: 1 });
    expect(mockTool.executeFn).toHaveBeenCalledWith({ b: 2 });

    // Ensure completion callbacks were called twice.
    expect(onAllToolCallsComplete).toHaveBeenCalledTimes(2);
  });

  it('should auto-approve remaining tool calls when first tool call is approved with ProceedAlways', async () => {
    let approvalMode = ApprovalMode.DEFAULT;
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getApprovalMode: () => approvalMode,
      setApprovalMode: (mode: ApprovalMode) => {
        approvalMode = mode;
      },
    } as unknown as Config;

    const testTool = new TestApprovalTool(mockConfig);
    const toolRegistry = {
      getTool: () => testTool,
      getFunctionDeclarations: () => [],
      getFunctionDeclarationsFiltered: () => [],
      registerTool: () => {},
      discoverAllTools: async () => {},
      discoverMcpTools: async () => {},
      discoverToolsForServer: async () => {},
      removeMcpToolsByServer: () => {},
      getAllTools: () => [],
      getToolsByServer: () => [],
      tools: new Map(),
      config: mockConfig,
      mcpClientManager: undefined,
      getToolByName: () => testTool,
      getToolByDisplayName: () => testTool,
      getTools: () => [],
      discoverTools: async () => {},
      discovery: {},
    };

    const onAllToolCallsComplete = vi.fn();
    const onToolCallsUpdate = vi.fn();
    const pendingConfirmations: Array<
      (outcome: ToolConfirmationOutcome) => void
    > = [];

    const scheduler = new CoreToolScheduler({
      config: mockConfig,
      toolRegistry: toolRegistry as unknown as ToolRegistry,
      onAllToolCallsComplete,
      onToolCallsUpdate: (toolCalls) => {
        onToolCallsUpdate(toolCalls);
        // Capture confirmation handlers for awaiting_approval tools
        toolCalls.forEach((call) => {
          if (call.status === 'awaiting_approval') {
            const waitingCall = call as WaitingToolCall;
            if (waitingCall.confirmationDetails?.onConfirm) {
              const originalHandler = pendingConfirmations.find(
                (h) => h === waitingCall.confirmationDetails.onConfirm,
              );
              if (!originalHandler) {
                pendingConfirmations.push(
                  waitingCall.confirmationDetails.onConfirm,
                );
              }
            }
          }
        });
      },
      getPreferredEditor: () => 'vscode',
      onEditorClose: vi.fn(),
    });

    const abortController = new AbortController();

    // Schedule multiple tools that need confirmation
    const requests = [
      {
        callId: '1',
        name: 'testApprovalTool',
        args: { id: 'first' },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
      {
        callId: '2',
        name: 'testApprovalTool',
        args: { id: 'second' },
        isClientInitiated: false,
        prompt_id: 'prompt-2',
      },
      {
        callId: '3',
        name: 'testApprovalTool',
        args: { id: 'third' },
        isClientInitiated: false,
        prompt_id: 'prompt-3',
      },
    ];

    await scheduler.schedule(requests, abortController.signal);

    // Wait for all tools to be awaiting approval
    await vi.waitFor(() => {
      const calls = onToolCallsUpdate.mock.calls.at(-1)?.[0] as ToolCall[];
      expect(calls?.length).toBe(3);
      expect(calls?.every((call) => call.status === 'awaiting_approval')).toBe(
        true,
      );
    });

    expect(pendingConfirmations.length).toBe(3);

    // Approve the first tool with ProceedAlways
    const firstConfirmation = pendingConfirmations[0];
    firstConfirmation(ToolConfirmationOutcome.ProceedAlways);

    // Wait for all tools to be completed
    await vi.waitFor(() => {
      expect(onAllToolCallsComplete).toHaveBeenCalled();
      const completedCalls = onAllToolCallsComplete.mock.calls.at(
        -1,
      )?.[0] as ToolCall[];
      expect(completedCalls?.length).toBe(3);
      expect(completedCalls?.every((call) => call.status === 'success')).toBe(
        true,
      );
    });

    // Verify approval mode was changed
    expect(approvalMode).toBe(ApprovalMode.AUTO_EDIT);
  });
});
