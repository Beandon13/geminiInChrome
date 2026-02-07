declare module "chrome-remote-interface" {
  interface CDPClient {
    Page: {
      enable(): Promise<void>;
      navigate(params: { url: string }): Promise<any>;
      loadEventFired(): Promise<any>;
      captureScreenshot(params?: {
        format?: string;
        quality?: number;
      }): Promise<{ data: string }>;
      javascriptDialogOpening(
        handler: (params: { type: string; message?: string }) => void
      ): void;
      handleJavaScriptDialog(params: {
        accept: boolean;
        promptText?: string;
      }): Promise<void>;
    };
    Runtime: {
      enable(): Promise<void>;
      evaluate(params: {
        expression: string;
        awaitPromise?: boolean;
        returnByValue?: boolean;
      }): Promise<{ result: { value?: any; type?: string; description?: string } }>;
    };
    DOM: {
      enable(): Promise<void>;
    };
    Input: {
      dispatchKeyEvent(params: {
        type: string;
        text?: string;
        key?: string;
        code?: string;
        unmodifiedText?: string;
        windowsVirtualKeyCode?: number;
        modifiers?: number;
      }): Promise<void>;
    };
    close(): Promise<void>;
  }

  interface CDPOptions {
    host?: string;
    port?: number;
    target?: string;
  }

  interface CDPTarget {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl?: string;
  }

  function CDP(options?: CDPOptions): Promise<CDPClient>;

  namespace CDP {
    function List(options?: {
      host?: string;
      port?: number;
    }): Promise<CDPTarget[]>;

    type Client = CDPClient;
  }

  export = CDP;
}
