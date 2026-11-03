export function price(amount: number): number {
    return amount * 1.25;
}

export const CURRENCY = 'USD';

export function label(name: string): string {
    return name.trim();
}

export const VERSION = 2;

export const TAGLINE = 'fast, no bugs';

export const NAME = 'conflate';

export function legacy(): void {
    console.log('legacy v2');
}

export const END = true;

export function discount(amount: number): number {
    return amount * 0.9;
}
