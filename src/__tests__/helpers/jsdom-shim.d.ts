// Minimal typings for the parts of jsdom the phone-page harness uses (@types/jsdom is not installed;
// jsdom itself is already a dev dependency through the vitest environment).
declare module "jsdom" {
  export class VirtualConsole {
    constructor();
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    readonly window: Window & typeof globalThis;
  }
}
