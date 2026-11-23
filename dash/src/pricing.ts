import pricesJson from "../prices.json";
import config from "../config.json";

export type Usage = {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
  webSearch: number;
  writeUnknown?: number;
};

export type Rates = {
  input: number;
  output: number;
  write5m: number;
  write1h: number;
  read: number;
};

type RateCard = Rates & { longContext?: Rates };

const prices = pricesJson as Record<string, RateCard>;

function cardFor(model: string): RateCard | null {
  return prices[model] ?? prices[model.replace(/-\d{8}$/, "")] ?? null;
}

export function ratesFor(model: string): Rates | null {
  return cardFor(model);
}

export function effectiveRates(model: string, contextTokens: number): Rates | null {
  const card = cardFor(model);
  if (!card) return null;
  if (contextTokens > 100_000 && card.longContext) return card.longContext;
  return card;
}

export function requestCost(model: string, usage: Usage): number | null {
  const rate = effectiveRates(model, usage.input + usage.write5m + usage.write1h + (usage.writeUnknown || 0) + usage.read);
  if (!rate) return null;
  return (
    usage.input * rate.input +
    usage.write5m * rate.write5m +
    usage.write1h * rate.write1h +
    usage.read * rate.read +
    usage.output * rate.output
  ) / 1_000_000 + usage.webSearch * config.webSearchUsd;
}
