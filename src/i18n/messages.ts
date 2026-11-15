import { anatomyMessages } from "./anatomyMessages";
import { layoutMessages } from "./layoutMessages";
import { presentationMessages } from "./presentationMessages";
import { referenceMessages } from "./referenceMessages";
import { viewerMessages } from "./viewerMessages";
import { viewerLeafMessages } from "./viewerLeaf";
import { workspaceMessages } from "./workspaceMessages";
import { freeSliceMessages } from "./freeSliceMessages";
import { classroomMessages } from "./classroomMessages";

export type Locale = "zh" | "en";
export type MessageParams = Record<string, string | number>;

export const messages: Record<string, string> = {
  ...anatomyMessages, ...layoutMessages, ...presentationMessages, ...referenceMessages,
  ...viewerMessages, ...viewerLeafMessages, ...workspaceMessages, ...freeSliceMessages, ...classroomMessages,
  "界面语言": "Interface language",
  "切换为英文": "Switch to English",
  "切换为中文": "Switch to Chinese",
};

/** Translate display text only. Model values, identifiers and user data stay intact. */
export function translate(message: string, locale: Locale, params?: MessageParams): string {
  const result = locale === "en" ? messages[message] ?? message : message;
  return params ? result.replace(/\{([\w]+)\}/g, (match, key: string) => params[key] === undefined ? match : String(params[key])) : result;
}
