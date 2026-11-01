"use client";

import { createContext, useCallback, useContext, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Glass } from "@/components/ui/Glass";
import { ApiError, passcodeStore } from "@/lib/api";

type WithPasscode = <T>(action: (passcode: string) => Promise<T>) => Promise<T | null>;

const PasscodeContext = createContext<WithPasscode>(async () => null);

interface Prompt {
  error: string | null;
  resolve: (value: string | null) => void;
}

/**
 * Write actions need the demo passcode. The modal asks once, the code is kept in
 * localStorage and sent as X-Demo-Passcode; a 401 clears it and asks again.
 */
export function PasscodeProvider({ children }: { children: ReactNode }) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const ask = useCallback(
    (error: string | null) =>
      new Promise<string | null>((resolve) => {
        setValue("");
        setPrompt({ error, resolve });
      }),
    [],
  );

  const withPasscode = useCallback<WithPasscode>(
    async (action) => {
      let code = passcodeStore.get();
      let error: string | null = null;
      for (;;) {
        if (!code) {
          code = await ask(error);
          if (!code) return null;
        }
        try {
          const result = await action(code);
          passcodeStore.set(code);
          return result;
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            passcodeStore.clear();
            code = null;
            error = "That passcode wasn't accepted. Check it and try again.";
            continue;
          }
          throw e;
        }
      }
    },
    [ask],
  );

  function close(result: string | null) {
    prompt?.resolve(result);
    setPrompt(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim()) close(value.trim());
  }

  return (
    <PasscodeContext.Provider value={withPasscode}>
      {children}
      {prompt && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 px-4"
          onMouseDown={(e) => e.target === e.currentTarget && close(null)}
        >
          <Glass
            as="form"
            role="dialog"
            aria-modal="true"
            aria-labelledby="passcode-title"
            onSubmit={submit}
            onKeyDown={(e: React.KeyboardEvent) => e.key === "Escape" && close(null)}
            className="w-full max-w-sm rounded-2xl p-5"
          >
            <h2 id="passcode-title" className="font-display text-base font-semibold">
              Demo passcode
            </h2>
            <p className="mt-1 text-[13px] text-muted">
              Reviews and test submissions change shared data, so they need the demo passcode. It is kept in this
              browser only.
            </p>
            <input
              ref={inputRef}
              autoFocus
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={Boolean(prompt.error)}
              aria-describedby={prompt.error ? "passcode-error" : undefined}
              className="mt-4 w-full rounded-lg border border-line-strong bg-black/30 px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
              placeholder="fqc-…"
            />
            {prompt.error && (
              <p id="passcode-error" role="alert" className="mt-2 text-[13px] text-crit">
                {prompt.error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => close(null)}
                className="rounded-lg px-3 py-1.5 text-[13px] text-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110"
              >
                Unlock
              </button>
            </div>
          </Glass>
        </div>
      )}
    </PasscodeContext.Provider>
  );
}

export function useWithPasscode() {
  return useContext(PasscodeContext);
}
