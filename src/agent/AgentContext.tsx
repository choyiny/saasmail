import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

export interface AgentNavigationContext {
  inbox?: string;
  folder?: string;
  selectedMessageRef?: string;
  personId?: string;
}

type AgentContextValue = {
  context: AgentNavigationContext;
  publish: (next: AgentNavigationContext) => void;
  clear: () => void;
};

const AgentContext = createContext<AgentContextValue>({
  context: {},
  publish: () => {},
  clear: () => {},
});

export function AgentContextProvider({ children }: PropsWithChildren) {
  const [context, setContext] = useState<AgentNavigationContext>({});

  const publish = useCallback((next: AgentNavigationContext) => {
    setContext(next);
  }, []);

  const clear = useCallback(() => setContext({}), []);

  const value = useMemo(
    () => ({ context, publish, clear }),
    [context, publish, clear],
  );

  return (
    <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
  );
}

export function useAgentContext() {
  return useContext(AgentContext);
}
