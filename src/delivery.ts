// Delivery of background run completions to the parent session: one
// message per finished generation, steered into the current parent run or
// starting a new turn when idle. The sender is injected, so the logic is
// testable without Pi.

import type { RunRecord } from './runs.ts';
import { formatRun } from './tools.ts';

export interface DeliveryMessage {
  customType: string;
  content: string;
  display: boolean;
  details: { id: string; agent: string; state: string; generation: number };
}

export interface DeliveryOptions {
  triggerTurn: boolean;
  deliverAs: 'steer';
}

export interface DeliveryConfig {
  send: (message: DeliveryMessage, options: DeliveryOptions) => void;
  markRead: (id: string) => unknown;
  // false once the parent session is gone
  isActive?: () => boolean;
  // total send attempts
  retries?: number;
  retryDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => void;
}

export interface Delivery {
  deliver: (run: RunRecord) => void;
  stop: () => void;
}

const defaultSetTimer = (fn: () => void, ms: number): void => {
  setTimeout(fn, ms).unref();
};

export const createDelivery = (config: DeliveryConfig): Delivery => {
  const { send, markRead, isActive } = config;
  const retries = config.retries ?? 3;
  const retryDelayMs = config.retryDelayMs ?? 500;
  const setTimer = config.setTimer ?? defaultSetTimer;
  const seen = new Set<string>();
  let stopped = false;

  const alive = (): boolean => !stopped && (isActive?.() ?? true);

  const attempt = (message: DeliveryMessage, id: string, left: number) => {
    if (!alive()) return;
    try {
      send(message, { triggerTurn: true, deliverAs: 'steer' });
    } catch {
      // the result stays readable via agent_result and stays unread
      if (left > 1) {
        setTimer(() => attempt(message, id, left - 1), retryDelayMs);
      }
      return;
    }
    markRead(id);
  };

  return {
    deliver(run) {
      if (!run.background || !alive()) return;
      const key = `${run.id}:${run.generation}`;
      if (seen.has(key)) return;
      seen.add(key);
      const message: DeliveryMessage = {
        customType: 'opium-agent-result',
        content: `Background agent run finished.\n${formatRun(run)}`,
        display: true,
        details: {
          id: run.id,
          agent: run.agent,
          state: run.state,
          generation: run.generation,
        },
      };
      attempt(message, run.id, retries);
    },
    stop() {
      stopped = true;
    },
  };
};
