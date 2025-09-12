/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ToolCallRequestInfo,
  ToolCallResponseInfo,
  ToolConfirmationOutcome,
  ToolCallConfirmationDetails,
  ToolResult,
  ToolResultDisplay,
  ToolRegistry,
  ApprovalMode,
  EditorType,
  Config,
  logToolCall,
  ToolCallEvent,
  ToolConfirmationPayload,
  ToolErrorType,
  AnyDeclarativeTool,
  AnyToolInvocation,
} from '../index.js';
import { Part, PartListUnion } from '@google/genai';
import { getResponseTextFromParts } from '../utils/generateContentResponseUtilities.js';
import { partToString } from '../utils/partUtils.js';
import {
  isModifiableDeclarativeTool,
  ModifyContext,
  modifyWithEditor,
} from '../tools/modifiable-tool.js';
import * as Diff from 'diff';

export type ValidatingToolCall = {
  status: 'validating';
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  invocation: AnyToolInvocation;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
};

export type ScheduledToolCall = {
  status: 'scheduled';
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  invocation: AnyToolInvocation;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
};

export type ErroredToolCall = {
  status: 'error';
  request: ToolCallRequestInfo;
  response: ToolCallResponseInfo;
  tool?: AnyDeclarativeTool;
  durationMs?: number;
  outcome?: ToolConfirmationOutcome;
};

export type SuccessfulToolCall = {
  status: 'success';
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  response: ToolCallResponseInfo;
  invocation: AnyToolInvocation;
  durationMs?: number;
  outcome?: ToolConfirmationOutcome;
};

export type ExecutingToolCall = {
  status: 'executing';
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  invocation: AnyToolInvocation;
  liveOutput?: ToolResultDisplay;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
};

export type CancelledToolCall = {
  status: 'cancelled';
  request: ToolCallRequestInfo;
  response: ToolCallResponseInfo;
  tool: AnyDeclarativeTool;
  invocation: AnyToolInvocation;
  durationMs?: number;
  outcome?: ToolConfirmationOutcome;
};

export type WaitingToolCall = {
  status: 'awaiting_approval';
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  invocation: AnyToolInvocation;
  confirmationDetails: ToolCallConfirmationDetails;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
};

export type Status = ToolCall['status'];

export type ToolCall =
  | ValidatingToolCall
  | ScheduledToolCall
  | ErroredToolCall
  | SuccessfulToolCall
  | ExecutingToolCall
  | CancelledToolCall
  | WaitingToolCall;

export type CompletedToolCall =
  | SuccessfulToolCall
  | CancelledToolCall
  | ErroredToolCall;

export type ConfirmHandler = (
  toolCall: WaitingToolCall,
) => Promise<ToolConfirmationOutcome>;

export type OutputUpdateHandler = (
  toolCallId: string,
  outputChunk: ToolResultDisplay,
) => void;

export type AllToolCallsCompleteHandler = (
  completedToolCalls: CompletedToolCall[],
) => Promise<void>;

export type ToolCallsUpdateHandler = (toolCalls: ToolCall[]) => void;

/**
 * Formats tool output for a Gemini FunctionResponse.
 */
function createFunctionResponsePart(
  callId: string,
  toolName: string,
  output: string,
): Part {
  return {
    functionResponse: {
      id: callId,
      name: toolName,
      response: { output },
    },
  };
}

export function convertToFunctionResponse(
  toolName: string,
  callId: string,
  llmContent: PartListUnion,
): PartListUnion {
  const contentToProcess =
    Array.isArray(llmContent) && llmContent.length === 1
      ? llmContent[0]
      : llmContent;

  if (typeof contentToProcess === 'string') {
    return createFunctionResponsePart(callId, toolName, contentToProcess);
  }

  if (Array.isArray(contentToProcess)) {
    return createFunctionResponsePart(
      callId,
      toolName,
      partToString(contentToProcess),
    );
  }

  // After this point, contentToProcess is a single Part object.
  if (contentToProcess.functionResponse) {
    if (contentToProcess.functionResponse.response?.['content']) {
      const stringifiedOutput =
        getResponseTextFromParts(
          contentToProcess.functionResponse.response['content'] as Part[],
        ) || '';
      return createFunctionResponsePart(callId, toolName, stringifiedOutput);
    }
    // It's a functionResponse that we should pass through as is.
    return contentToProcess;
  }

  if (contentToProcess.inlineData || contentToProcess.fileData) {
    const mimeType =
      contentToProcess.inlineData?.mimeType ||
      contentToProcess.fileData?.mimeType ||
      'unknown';
    const functionResponse = createFunctionResponsePart(
      callId,
      toolName,
      `Binary content of type ${mimeType} was processed.`,
    );
    return [functionResponse, contentToProcess];
  }

  if (contentToProcess.text !== undefined) {
    return createFunctionResponsePart(callId, toolName, contentToProcess.text);
  }

  // Default case for other kinds of parts.
  return createFunctionResponsePart(
    callId,
    toolName,
    'Tool execution succeeded.',
  );
}

const createErrorResponse = (
  request: ToolCallRequestInfo,
  error: Error,
  errorType: ToolErrorType | undefined,
): ToolCallResponseInfo => ({
  callId: request.callId,
  error,
  responseParts: {
    functionResponse: {
      id: request.callId,
      name: request.name,
      response: { error: error.message },
    },
  },
  resultDisplay: error.message,
  errorType,
});

interface CoreToolSchedulerOptions {
  toolRegistry: ToolRegistry;
  outputUpdateHandler?: OutputUpdateHandler;
  onAllToolCallsComplete?: AllToolCallsCompleteHandler;
  onToolCallsUpdate?: ToolCallsUpdateHandler;
  getPreferredEditor: () => EditorType | undefined;
  config: Config;
  onEditorClose: () => void;
}

export class CoreToolScheduler {
  private toolRegistry: ToolRegistry;
  private toolCalls: ToolCall[] = [];
  private outputUpdateHandler?: OutputUpdateHandler;
  private onAllToolCallsComplete?: AllToolCallsCompleteHandler;
  private onToolCallsUpdate?: ToolCallsUpdateHandler;
  private getPreferredEditor: () => EditorType | undefined;
  private config: Config;
  private onEditorClose: () => void;
  private isFinalizingToolCalls = false;
  private isScheduling = false;
  private requestQueue: Array<{
    request: ToolCallRequestInfo | ToolCallRequestInfo[];
    signal: AbortSignal;
    resolve: () => void;
    reject: (reason?: Error) => void;
  }> = [];

  constructor(options: CoreToolSchedulerOptions) {
    this.config = options.config;
    this.toolRegistry = options.toolRegistry;
    this.outputUpdateHandler = options.outputUpdateHandler;
    this.onAllToolCallsComplete = options.onAllToolCallsComplete;
    this.onToolCallsUpdate = options.onToolCallsUpdate;
    this.getPreferredEditor = options.getPreferredEditor;
    this.onEditorClose = options.onEditorClose;
  }

  private setStatusInternal(
    targetCallId: string,
    status: 'success',
    response: ToolCallResponseInfo,
  ): void;
  private setStatusInternal(
    targetCallId: string,
    status: 'awaiting_approval',
    confirmationDetails: ToolCallConfirmationDetails,
  ): void;
  private setStatusInternal(
    targetCallId: string,
    status: 'error',
    response: ToolCallResponseInfo,
  ): void;
  private setStatusInternal(
    targetCallId: string,
    status: 'cancelled',
    reason: string,
  ): void;
  private setStatusInternal(
    targetCallId: string,
    status: 'executing' | 'scheduled' | 'validating',
  ): void;
  private setStatusInternal(
    targetCallId: string,
    newStatus: Status,
    auxiliaryData?: unknown,
  ): void {
    this.toolCalls = this.toolCalls.map((currentCall) => {
      if (
        currentCall.request.callId !== targetCallId ||
        currentCall.status === 'success' ||
        currentCall.status === 'error' ||
        currentCall.status === 'cancelled'
      ) {
        return currentCall;
      }

      // currentCall is a non-terminal state here and should have startTime and tool.
      const existingStartTime = currentCall.startTime;
      const toolInstance = currentCall.tool;
      const invocation = currentCall.invocation;

      const outcome = currentCall.outcome;

      switch (newStatus) {
        case 'success': {
          const durationMs = existingStartTime
            ? Date.now() - existingStartTime
            : undefined;
          return {
            request: currentCall.request,
            tool: toolInstance,
            invocation,
            status: 'success',
            response: auxiliaryData as ToolCallResponseInfo,
            durationMs,
            outcome,
          } as SuccessfulToolCall;
        }
        case 'error': {
          const durationMs = existingStartTime
            ? Date.now() - existingStartTime
            : undefined;
          return {
            request: currentCall.request,
            status: 'error',
            tool: toolInstance,
            response: auxiliaryData as ToolCallResponseInfo,
            durationMs,
            outcome,
          } as ErroredToolCall;
        }
        case 'awaiting_approval':
          return {
            request: currentCall.request,
            tool: toolInstance,
            status: 'awaiting_approval',
            confirmationDetails: auxiliaryData as ToolCallConfirmationDetails,
            startTime: existingStartTime,
            outcome,
            invocation,
          } as WaitingToolCall;
        case 'scheduled':
          return {
            request: currentCall.request,
            tool: toolInstance,
            status: 'scheduled',
            startTime: existingStartTime,
            outcome,
            invocation,
          } as ScheduledToolCall;
        case 'cancelled': {
          const durationMs = existingStartTime
            ? Date.now() - existingStartTime
            : undefined;

          // Preserve diff for cancelled edit operations
          let resultDisplay: ToolResultDisplay | undefined = undefined;
          if (currentCall.status === 'awaiting_approval') {
            const waitingCall = currentCall as WaitingToolCall;
            if (waitingCall.confirmationDetails.type === 'edit') {
              resultDisplay = {
                fileDiff: waitingCall.confirmationDetails.fileDiff,
                fileName: waitingCall.confirmationDetails.fileName,
                originalContent:
                  waitingCall.confirmationDetails.originalContent,
                newContent: waitingCall.confirmationDetails.newContent,
              };
            }
          } else if (currentCall.status === 'executing') {
            // If the tool was streaming live output, preserve the latest
            // output so the UI can continue to show it after cancellation.
            const executingCall = currentCall as ExecutingToolCall;
            if (executingCall.liveOutput !== undefined) {
              resultDisplay = executingCall.liveOutput;
            }
          }

          return {
            request: currentCall.request,
            tool: toolInstance,
            invocation,
            status: 'cancelled',
            response: {
              callId: currentCall.request.callId,
              responseParts: {
                functionResponse: {
                  id: currentCall.request.callId,
                  name: currentCall.request.name,
                  response: {
                    error: `[Operation Cancelled] Reason: ${auxiliaryData}`,
                  },
                },
              },
              resultDisplay,
              error: undefined,
              errorType: undefined,
            },
            durationMs,
            outcome,
          } as CancelledToolCall;
        }
        case 'validating':
          return {
            request: currentCall.request,
            tool: toolInstance,
            status: 'validating',
            startTime: existingStartTime,
            outcome,
            invocation,
          } as ValidatingToolCall;
        case 'executing':
          return {
            request: currentCall.request,
            tool: toolInstance,
            status: 'executing',
            startTime: existingStartTime,
            outcome,
            invocation,
          } as ExecutingToolCall;
        default: {
          const exhaustiveCheck: never = newStatus;
          return exhaustiveCheck;
        }
      }
    });
    this.notifyToolCallsUpdate();
    this.checkAndNotifyCompletion();
  }

  private setArgsInternal(targetCallId: string, args: unknown): void {
    this.toolCalls = this.toolCalls.map((call) => {
      // We should never be asked to set args on an ErroredToolCall, but
      // we guard for the case anyways.
      if (call.request.callId !== targetCallId || call.status === 'error') {
        return call;
      }

      const invocationOrError = this.buildInvocation(
        call.tool,
        args as Record<string, unknown>,
      );
      if (invocationOrError instanceof Error) {
        const response = createErrorResponse(
          call.request,
          invocationOrError,
          ToolErrorType.INVALID_TOOL_PARAMS,
        );
        return {
          request: { ...call.request, args: args as Record<string, unknown> },
          status: 'error',
          tool: call.tool,
          response,
        } as ErroredToolCall;
      }

      return {
        ...call,
        request: { ...call.request, args: args as Record<string, unknown> },
        invocation: invocationOrError,
      };
    });
  }

  private isRunning(): boolean {
    return (
      this.isFinalizingToolCalls ||
      this.toolCalls.some(
        (call) =>
          call.status === 'executing' || call.status === 'awaiting_approval',
      )
    );
  }

  private buildInvocation(
    tool: AnyDeclarativeTool,
    args: object,
  ): AnyToolInvocation | Error {
    try {
      return tool.build(args);
    } catch (e) {
      if (e instanceof Error) {
        return e;
      }
      return new Error(String(e));
    }
  }

  schedule(
    request: ToolCallRequestInfo | ToolCallRequestInfo[],
    signal: AbortSignal,
  ): Promise<void> {
    if (this.isRunning() || this.isScheduling) {
      return new Promise((resolve, reject) => {
        const abortHandler = () => {
          // Find and remove the request from the queue
          const index = this.requestQueue.findIndex(
            (item) => item.request === request,
          );
          if (index > -1) {
            this.requestQueue.splice(index, 1);
            reject(new Error('Tool call cancelled while in queue.'));
          }
        };

        signal.addEventListener('abort', abortHandler, { once: true });

        this.requestQueue.push({
          request,
          signal,
          resolve: () => {
            signal.removeEventListener('abort', abortHandler);
            resolve();
          },
          reject: (reason?: Error) => {
            signal.removeEventListener('abort', abortHandler);
            reject(reason);
          },
        });
      });
    }
    return this._schedule(request, signal);
  }

  private async _schedule(
    request: ToolCallRequestInfo | ToolCallRequestInfo[],
    signal: AbortSignal,
  ): Promise<void> {
    this.isScheduling = true;
    try {
      if (this.isRunning()) {
        throw new Error(
          'Cannot schedule new tool calls while other tool calls are actively running (executing or awaiting approval).',
        );
      }
      const requestsToProcess = Array.isArray(request) ? request : [request];

      const newToolCalls: ToolCall[] = requestsToProcess.map(
        (reqInfo): ToolCall => {
          const toolInstance = this.toolRegistry.getTool(reqInfo.name);
          if (!toolInstance) {
            return {
              status: 'error',
              request: reqInfo,
              response: createErrorResponse(
                reqInfo,
                new Error(`Tool "${reqInfo.name}" not found in registry.`),
                ToolErrorType.TOOL_NOT_REGISTERED,
              ),
              durationMs: 0,
            };
          }

          const invocationOrError = this.buildInvocation(
            toolInstance,
            reqInfo.args,
          );
          if (invocationOrError instanceof Error) {
            return {
              status: 'error',
              request: reqInfo,
              tool: toolInstance,
              response: createErrorResponse(
                reqInfo,
                invocationOrError,
                ToolErrorType.INVALID_TOOL_PARAMS,
              ),
              durationMs: 0,
            };
          }

          return {
            status: 'validating',
            request: reqInfo,
            tool: toolInstance,
            invocation: invocationOrError,
            startTime: Date.now(),
          };
        },
      );

      this.toolCalls = this.toolCalls.concat(newToolCalls);
      this.notifyToolCallsUpdate();

      for (const toolCall of newToolCalls) {
        if (toolCall.status !== 'validating') {
          continue;
        }

        const { request: reqInfo, invocation } = toolCall;

        try {
          if (signal.aborted) {
            this.setStatusInternal(
              reqInfo.callId,
              'cancelled',
              'Tool call cancelled by user.',
            );
            continue;
          }
          if (this.config.getApprovalMode() === ApprovalMode.YOLO) {
            this.setToolCallOutcome(
              reqInfo.callId,
              ToolConfirmationOutcome.ProceedAlways,
            );
            this.setStatusInternal(reqInfo.callId, 'scheduled');
          } else {
            const confirmationDetails =
              await invocation.shouldConfirmExecute(signal);

            if (confirmationDetails) {
              // Allow IDE to resolve confirmation
              if (
                confirmationDetails.type === 'edit' &&
                confirmationDetails.ideConfirmation
              ) {
                confirmationDetails.ideConfirmation.then((resolution) => {
                  if (resolution.status === 'accepted') {
                    this.handleConfirmationResponse(
                      reqInfo.callId,
                      confirmationDetails.onConfirm,
                      ToolConfirmationOutcome.ProceedOnce,
                      signal,
                    );
                  } else {
                    this.handleConfirmationResponse(
                      reqInfo.callId,
                      confirmationDetails.onConfirm,
                      ToolConfirmationOutcome.Cancel,
                      signal,
                    );
                  }
                });
              }

              const originalOnConfirm = confirmationDetails.onConfirm;
              const wrappedConfirmationDetails: ToolCallConfirmationDetails = {
                ...confirmationDetails,
                onConfirm: (
                  outcome: ToolConfirmationOutcome,
                  payload?: ToolConfirmationPayload,
                ) =>
                  this.handleConfirmationResponse(
                    reqInfo.callId,
                    originalOnConfirm,
                    outcome,
                    signal,
                    payload,
                  ),
              };
              this.setStatusInternal(
                reqInfo.callId,
                'awaiting_approval',
                wrappedConfirmationDetails,
              );
            } else {
              this.setToolCallOutcome(
                reqInfo.callId,
                ToolConfirmationOutcome.ProceedAlways,
              );
              this.setStatusInternal(reqInfo.callId, 'scheduled');
            }
          }
        } catch (error) {
          this.setStatusInternal(
            reqInfo.callId,
            'error',
            createErrorResponse(
              reqInfo,
              error instanceof Error ? error : new Error(String(error)),
              ToolErrorType.UNHANDLED_EXCEPTION,
            ),
          );
        }
      }
      this.attemptExecutionOfScheduledCalls(signal);
      void this.checkAndNotifyCompletion();
    } finally {
      this.isScheduling = false;
    }
  }

  async handleConfirmationResponse(
    callId: string,
    originalOnConfirm: (outcome: ToolConfirmationOutcome) => Promise<void>,
    outcome: ToolConfirmationOutcome,
    signal: AbortSignal,
    payload?: ToolConfirmationPayload,
  ): Promise<void> {
    const toolCall = this.toolCalls.find(
      (c) => c.request.callId === callId && c.status === 'awaiting_approval',
    );

    if (toolCall && toolCall.status === 'awaiting_approval') {
      await originalOnConfirm(outcome);
    }

    if (outcome === ToolConfirmationOutcome.ProceedAlways) {
      await this.autoApproveCompatiblePendingTools(signal, callId);
    }

    this.setToolCallOutcome(callId, outcome);

    if (outcome === ToolConfirmationOutcome.Cancel || signal.aborted) {
      this.setStatusInternal(
        callId,
        'cancelled',
        'User did not allow tool call',
      );
    } else if (outcome === ToolConfirmationOutcome.ModifyWithEditor) {
      const waitingToolCall = toolCall as WaitingToolCall;
      if (isModifiableDeclarativeTool(waitingToolCall.tool)) {
        const modifyContext = waitingToolCall.tool.getModifyContext(signal);
        const editorType = this.getPreferredEditor();
        if (!editorType) {
          return;
        }

        this.setStatusInternal(callId, 'awaiting_approval', {
          ...waitingToolCall.confirmationDetails,
          isModifying: true,
        } as ToolCallConfirmationDetails);

        const { updatedParams, updatedDiff } = await modifyWithEditor<
          typeof waitingToolCall.request.args
        >(
          waitingToolCall.request.args,
          modifyContext as ModifyContext<typeof waitingToolCall.request.args>,
          editorType,
          signal,
          this.onEditorClose,
        );
        this.setArgsInternal(callId, updatedParams);
        this.setStatusInternal(callId, 'awaiting_approval', {
          ...waitingToolCall.confirmationDetails,
          fileDiff: updatedDiff,
          isModifying: false,
        } as ToolCallConfirmationDetails);
      }
    } else {
      // If the client provided new content, apply it before scheduling.
      if (payload?.newContent && toolCall) {
        await this._applyInlineModify(
          toolCall as WaitingToolCall,
          payload,
          signal,
        );
      }
      this.setStatusInternal(callId, 'scheduled');
    }
    this.attemptExecutionOfScheduledCalls(signal);
  }

  /**
   * Applies user-provided content changes to a tool call that is awaiting confirmation.
   * This method updates the tool's arguments and refreshes the confirmation prompt with a new diff
   * before the tool is scheduled for execution.
   * @private
   */
  private async _applyInlineModify(
    toolCall: WaitingToolCall,
    payload: ToolConfirmationPayload,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      toolCall.confirmationDetails.type !== 'edit' ||
      !isModifiableDeclarativeTool(toolCall.tool)
    ) {
      return;
    }

    const modifyContext = toolCall.tool.getModifyContext(signal);
    const currentContent = await modifyContext.getCurrentContent(
      toolCall.request.args,
    );

    const updatedParams = modifyContext.createUpdatedParams(
      currentContent,
      payload.newContent,
      toolCall.request.args,
    );
    const updatedDiff = Diff.createPatch(
      modifyContext.getFilePath(toolCall.request.args),
      currentContent,
      payload.newContent,
      'Current',
      'Proposed',
    );

    this.setArgsInternal(toolCall.request.callId, updatedParams);
    this.setStatusInternal(toolCall.request.callId, 'awaiting_approval', {
      ...toolCall.confirmationDetails,
      fileDiff: updatedDiff,
    });
  }

  private attemptExecutionOfScheduledCalls(signal: AbortSignal): void {
    const allCallsFinalOrScheduled = this.toolCalls.every(
      (call) =>
        call.status === 'scheduled' ||
        call.status === 'cancelled' ||
        call.status === 'success' ||
        call.status === 'error',
    );

    if (allCallsFinalOrScheduled) {
      const callsToExecute = this.toolCalls.filter(
        (call) => call.status === 'scheduled',
      );

      callsToExecute.forEach((toolCall) => {
        if (toolCall.status !== 'scheduled') return;

        const scheduledCall = toolCall;
        const { callId, name: toolName } = scheduledCall.request;
        const invocation = scheduledCall.invocation;
        this.setStatusInternal(callId, 'executing');

        const liveOutputCallback = scheduledCall.tool.canUpdateOutput
          ? (outputChunk: ToolResultDisplay) => {
              if (this.outputUpdateHandler) {
                this.outputUpdateHandler(callId, outputChunk);
              }
              this.toolCalls = this.toolCalls.map((tc) =>
                tc.request.callId === callId && tc.status === 'executing'
                  ? { ...tc, liveOutput: outputChunk }
                  : tc,
              );
              this.notifyToolCallsUpdate();
            }
          : undefined;

        invocation
          .execute(signal, liveOutputCallback)
          .then(async (toolResult: ToolResult) => {
            if (signal.aborted) {
              this.setStatusInternal(
                callId,
                'cancelled',
                'User cancelled tool execution.',
              );
              return;
            }

            if (toolResult.error === undefined) {
              const response = convertToFunctionResponse(
                toolName,
                callId,
                toolResult.llmContent,
              );
              const successResponse: ToolCallResponseInfo = {
                callId,
                responseParts: response,
                resultDisplay: toolResult.returnDisplay,
                error: undefined,
                errorType: undefined,
              };
              this.setStatusInternal(callId, 'success', successResponse);
            } else {
              // It is a failure
              const error = new Error(toolResult.error.message);
              const errorResponse = createErrorResponse(
                scheduledCall.request,
                error,
                toolResult.error.type,
              );
              this.setStatusInternal(callId, 'error', errorResponse);
            }
          })
          .catch((executionError: Error) => {
            this.setStatusInternal(
              callId,
              'error',
              createErrorResponse(
                scheduledCall.request,
                executionError instanceof Error
                  ? executionError
                  : new Error(String(executionError)),
                ToolErrorType.UNHANDLED_EXCEPTION,
              ),
            );
          });
      });
    }
  }

  private async checkAndNotifyCompletion(): Promise<void> {
    const allCallsAreTerminal = this.toolCalls.every(
      (call) =>
        call.status === 'success' ||
        call.status === 'error' ||
        call.status === 'cancelled',
    );

    if (this.toolCalls.length > 0 && allCallsAreTerminal) {
      const completedCalls = [...this.toolCalls] as CompletedToolCall[];
      this.toolCalls = [];

      for (const call of completedCalls) {
        logToolCall(this.config, new ToolCallEvent(call));
      }

      if (this.onAllToolCallsComplete) {
        this.isFinalizingToolCalls = true;
        await this.onAllToolCallsComplete(completedCalls);
        this.isFinalizingToolCalls = false;
      }
      this.notifyToolCallsUpdate();
      // After completion, process the next item in the queue.
      if (this.requestQueue.length > 0) {
        const next = this.requestQueue.shift()!;
        this._schedule(next.request, next.signal)
          .then(next.resolve)
          .catch(next.reject);
      }
    }
  }

  private notifyToolCallsUpdate(): void {
    if (this.onToolCallsUpdate) {
      this.onToolCallsUpdate([...this.toolCalls]);
    }
  }

  private setToolCallOutcome(callId: string, outcome: ToolConfirmationOutcome) {
    this.toolCalls = this.toolCalls.map((call) => {
      if (call.request.callId !== callId) return call;
      return {
        ...call,
        outcome,
      };
    });
  }

  private async autoApproveCompatiblePendingTools(
    signal: AbortSignal,
    triggeringCallId: string,
  ): Promise<void> {
    const pendingTools = this.toolCalls.filter(
      (call) =>
        call.status === 'awaiting_approval' &&
        call.request.callId !== triggeringCallId,
    ) as WaitingToolCall[];

    for (const pendingTool of pendingTools) {
      try {
        const stillNeedsConfirmation =
          await pendingTool.invocation.shouldConfirmExecute(signal);

        if (!stillNeedsConfirmation) {
          this.setToolCallOutcome(
            pendingTool.request.callId,
            ToolConfirmationOutcome.ProceedAlways,
          );
          this.setStatusInternal(pendingTool.request.callId, 'scheduled');
        }
      } catch (error) {
        console.error(
          `Error checking confirmation for tool ${pendingTool.request.callId}:`,
          error,
        );
      }
    }
  }
}
