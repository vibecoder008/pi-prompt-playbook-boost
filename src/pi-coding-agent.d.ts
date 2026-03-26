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
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
    sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
  }

  export interface ExtensionContext {
    cwd: string;
    ui: ExtensionUI;
    hasUI: boolean;
    sessionManager: any;
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
  }
}
