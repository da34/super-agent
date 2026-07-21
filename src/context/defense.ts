import { ModelMessage } from "ai"
import { toolResultOutputToText } from "./tool-result-output"

export class TokenTracker {
  private lastPreciseCount = 0 // 上次 api 返回的精确值
  private pendingChars = 0 // 新增消息的字符数


  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens
    this.pendingChars = 0
  }

  addMessage(content: string): void {
    this.pendingChars += content.length
  }

  get estimatedTokens(): number {
    return this.lastPreciseCount + Math.ceil(this.pendingChars / 4)
  }
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part && typeof part.text === 'string') {
          chars += part.text.length;
        } else if ('output' in part) {
          chars += toolResultOutputToText(part.output).length;
        }
      }
    }
  }

  return Math.ceil(chars / 4 * 1.2)
}
