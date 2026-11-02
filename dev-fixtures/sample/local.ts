export function price(amount: number): number {
	return amount * 1.21;
}

export const CURRENCY = "EUR";

export function label(name: string): string {
	return name.trim().toUpperCase();
}

export const VERSION = 2;

export const NAME = "conflate";

export const END = true;
