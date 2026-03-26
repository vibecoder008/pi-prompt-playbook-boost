/**
 * Minimal type declarations for @mariozechner/pi-coding-agent.
 * These are resolved at runtime by pi's loader — this file
 * provides type-checking during development only.
 */
declare module "@mariozechner/pi-coding-agent" {
  export interface ExtensionAPI {
    on(event: string, handler: (...args: any[]) => any): void;
    registerCommand(name: string, options: {
      description: string;
      handler: (args: string | undefined, ctx: ExtensionCommandContext) => Promise<void>;
    }): void;
    registerShortcut(shortcut: string, options: {
      description?: string;
      handler: (ctx: ExtensionContext) => Promise<void> | void;
    }): void;
    exec(
      command: string,
      args: string[],
      options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
    ): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
    sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
  }

  export interface ModelRegistry {
    find(provider: string, id: string): Model | undefined;
    getApiKey(model: Model): Promise<string | undefined>;
  }

  export interface Model {
    provider: string;
    id: string;
    name: string;
    maxTokens: number;
    [key: string]: any;
  }

  /** Loader for cancellable TUI overlays. */
  export class BorderedLoader {
    signal: AbortSignal;
    onAbort?: () => void;
    constructor(tui: any, theme: any, message: string, options?: { cancellable?: boolean });
  }

  export interface ExtensionContext {
    cwd: string;
    ui: ExtensionUI;
    hasUI: boolean;
    sessionManager: any;
    model: Model | undefined;
    modelRegistry: ModelRegistry;
    isIdle(): boolean;
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle(): Promise<void>;
  }

  export interface ExtensionUI {
    notify(message: string, type?: "info" | "warning" | "error" | "success"): void;
    confirm(title: string, message: string): Promise<boolean>;
    select(title: string, options: string[]): Promise<number | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    setStatus(key: string, text: string | undefined): void;
    setEditorText(text: string): void;
    getEditorText(): string;
    custom<T>(factory: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any): Promise<T>;
  }
}

declare module "@mariozechner/pi-ai" {
  export interface Api {
    [key: string]: any;
  }

  export interface Message {
    role: "user" | "assistant";
    timestamp: number;
    content: MessageContent[];
  }

  export type MessageContent =
    | { type: "text"; text: string }
    | { type: "image"; source: any };

  export interface Context {
    systemPrompt: string;
    messages: Message[];
  }

  export interface AssistantMessage {
    content: { type: "text"; text: string }[];
    stopReason?: string;
  }

  export function complete(
    model: any,
    context: Context,
    options?: { apiKey?: string; signal?: AbortSignal; maxTokens?: number },
  ): Promise<AssistantMessage>;
}
