export type BrowserTool =
  | "navigate"
  | "click"
  | "submit"
  | "type"
  | "select"
  | "fill_form"
  | "wait"
  | "blocked"
  | "done";

export type OcrBlock = {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type ViewportSize = {
  width: number;
  height: number;
};

export type BrowserCoords = {
  x: number;
  y: number;
};

export type BrowserAction = {
  tool: BrowserTool;
  elementId: string | null;
  url: string | null;
  text: string | null;
  value: string | null;
  reasoning: string;
  coords?: BrowserCoords | null;
  coverLetterElementIds: string[];
  coverLetterRevealIds: string[];
  resumeElementIds: string[];
};

export type BrowserStepHistoryItem = {
  step: number;
  tool: string;
  reasoning?: string;
  elementId?: string | null;
  url?: string | null;
};

export type PageElement = {
  elementId: string;
  type: "action" | "field";
  tag: string;
  text: string;
  href?: string;
  context?: string;
  fieldType?: string;
  fieldKind?: "text" | "suggestion" | "select" | "file" | "radio" | "checkbox" | string;
  needsSuggestionPick?: boolean;
  label?: string;
  required?: boolean;
  options?: string[];
};
