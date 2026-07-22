import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from "../context/view";
import type { CommandHandler } from "./index";

export const contextCommands: CommandHandler[] = [
  (command, context) => {
    if (command !== "/context" && command !== "context") return false;

    const snapshot = buildContextSnapshot({
      modelName: context.modelName,
      modelId: context.modelId,
      windowTokens: context.windowTokens,
      systemPromptChars: context.systemPrompt.length,
      toolDescriptionChars: context.registry
        .getActiveTools()
        .reduce(
          (total, tool) =>
            total +
            tool.name.length +
            tool.description.length +
            JSON.stringify(tool.parameters).length,
          0,
        ),
      memoryChars: 0,
      skillsChars: 0,
      messages: context.messages,
    });
    console.log(renderContextView(snapshot));
    return true;
  },
  (command, context) => {
    if (command !== "/usage" && command !== "usage") return false;

    console.log(renderUsageView(context.tracker));
    return true;
  },
];
